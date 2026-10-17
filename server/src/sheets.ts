import crypto from 'crypto';
import https from 'https';

// Google Sheets export via direct fetch to the Sheets + Drive APIs —
// no SDK. Auth is a service-account JWT (RS256, signed with Node
// crypto) exchanged for an access token at Google's OAuth endpoint.
//
// Env vars:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL       (service account email)
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (PEM private key; the \\n escapes
//     in the env value are converted to real newlines before signing)
//   GOOGLE_SHARE_EMAIL (optional) — if set, the Sheet is shared with
//     this email as a writer; otherwise it is set to anyone-with-link
//     reader, and the coach shares it from Google Drive.
//
// If either credential env var is missing, the app reports
// not-configured — no HTTP call is made and no fake URL is ever
// returned. Same honest pattern as the Twilio log-only mode.

export type SheetsExportResult =
  | { mode: 'exported'; sheetId: string; sheetUrl: string }
  | { mode: 'not_configured' }
  | { mode: 'failed'; error: string };

export function isSheetsConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
}

function base64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Build + sign the service-account JWT (Google's OAuth2 JWT bearer
// flow). Token lifetime: 1 hour.
function buildJwt(): string {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL as string;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY as string;
  // Render env vars store the PEM key with literal \n escapes — but pastes
  // arrive in several shapes (single-escaped \n, double-escaped \\n, real
  // newlines, surrounding quotes). Normalize all of them before signing.
  let privateKey = rawKey.trim();
  if (
    (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
    (privateKey.startsWith("'") && privateKey.endsWith("'"))
  ) {
    privateKey = privateKey.slice(1, -1);
  }
  privateKey = privateKey.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

type GoogleApiResult = { ok: boolean; status: number; body: string };

function googleRequest(
  url: string,
  method: string,
  accessToken: string | null,
  body: unknown,
): Promise<GoogleApiResult> {
  const payload = body === null ? '' : JSON.stringify(body);
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = https.request(url, { method, headers, timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({ ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300, status: res.statusCode ?? 500, body: data });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Google API request timed out.'));
    });
    req.on('error', (err) => {
      resolve({ ok: false, status: 0, body: JSON.stringify({ error: err.message }) });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function googleError(result: GoogleApiResult, fallback: string): string {
  try {
    const parsed = JSON.parse(result.body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Keep the fallback.
  }
  return `${fallback} (HTTP ${result.status})`;
}

export interface SheetRows {
  boxScoreHeaders: string[];
  boxScoreRows: (string | number)[][];
  timelineHeaders: string[];
  timelineRows: (string | number)[][];
}

export async function exportGameToSheets(
  title: string,
  rows: SheetRows,
): Promise<SheetsExportResult> {
  if (!isSheetsConfigured()) return { mode: 'not_configured' };
  try {
    // 1. Exchange the signed JWT for an access token.
    const jwt = buildJwt();
    const tokenResult = await googleRequest(
      'https://oauth2.googleapis.com/token',
      'POST',
      null,
      { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt },
    );
    if (!tokenResult.ok) {
      return { mode: 'failed', error: googleError(tokenResult, 'Could not get a Google access token.') };
    }
    const tokenParsed = JSON.parse(tokenResult.body) as { access_token?: string };
    const accessToken = tokenParsed.access_token;
    if (!accessToken) {
      return { mode: 'failed', error: 'Google did not return an access token.' };
    }

    // 2. Create the spreadsheet with the two tabs.
    const createResult = await googleRequest(
      'https://sheets.googleapis.com/v4/spreadsheets',
      'POST',
      accessToken,
      {
        properties: { title },
        sheets: [{ properties: { title: 'Box Score' } }, { properties: { title: 'Timeline' } }],
      },
    );
    if (!createResult.ok) {
      return { mode: 'failed', error: googleError(createResult, 'Could not create the spreadsheet.') };
    }
    const created = JSON.parse(createResult.body) as { spreadsheetId?: string };
    const sheetId = created.spreadsheetId;
    if (!sheetId) {
      return { mode: 'failed', error: 'Google did not return a spreadsheet ID.' };
    }

    // 3. Write both tabs in one batchUpdate (headers + rows each).
    const writeResult = await googleRequest(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
      'POST',
      accessToken,
      {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: 'Box Score!A1', values: [rows.boxScoreHeaders, ...rows.boxScoreRows] },
          { range: 'Timeline!A1', values: [rows.timelineHeaders, ...rows.timelineRows] },
        ],
      },
    );
    if (!writeResult.ok) {
      return { mode: 'failed', error: googleError(writeResult, 'Could not write the game data to the spreadsheet.') };
    }

    // 4. Share: a named writer when GOOGLE_SHARE_EMAIL is set, otherwise
    // anyone-with-link reader so the coach can open it immediately.
    const shareEmail = (process.env.GOOGLE_SHARE_EMAIL ?? '').trim();
    const permission = shareEmail
      ? { role: 'writer', type: 'user', emailAddress: shareEmail }
      : { role: 'reader', type: 'anyone' };
    const shareResult = await googleRequest(
      `https://www.googleapis.com/drive/v3/files/${sheetId}/permissions`,
      'POST',
      accessToken,
      permission,
    );
    if (!shareResult.ok) {
      // The Sheet exists and has the data — sharing failing must not
      // pretend the export failed. Return the link; the coach can share
      // it from Google Drive.
      return { mode: 'exported', sheetId, sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}` };
    }

    return { mode: 'exported', sheetId, sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}` };
  } catch (err) {
    return { mode: 'failed', error: err instanceof Error ? err.message : 'Google Sheets export failed.' };
  }
}
