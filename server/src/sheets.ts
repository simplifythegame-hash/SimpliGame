import https from 'https';

// Google Sheets export via direct fetch to the Sheets + Drive APIs —
// no SDK. Auth is OAuth 2.0 user auth: a refresh token (obtained once
// via the OAuth consent flow) is exchanged for a fresh access token on
// every export. The app acts as the coach's Google account, so Sheets
// land in their Drive.
//
// (Service-account auth was tried first and does not work for file
// creation: Google returns 403 PERMISSION_DENIED on
// spreadsheets.create and "storage quota exceeded" on Drive create for
// service accounts in this setup.)
//
// Env vars:
//   GOOGLE_OAUTH_CLIENT_ID     (OAuth client ID)
//   GOOGLE_OAUTH_CLIENT_SECRET (OAuth client secret)
//   GOOGLE_OAUTH_REFRESH_TOKEN (refresh token from the one-time consent)
//   GOOGLE_SHARE_EMAIL (optional) — if set, the Sheet is shared with
//     this email as a writer; otherwise it is set to anyone-with-link
//     reader, and the coach shares it from Google Drive.
//
// If any credential env var is missing, the app reports
// not-configured — no HTTP call is made and no fake URL is ever
// returned. Same honest pattern as the Twilio log-only mode.

export type SheetsExportResult =
  | { mode: 'exported'; sheetId: string; sheetUrl: string }
  | { mode: 'not_configured' }
  | { mode: 'failed'; error: string };

export function isSheetsConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  );
}

// Exchange the stored refresh token for a fresh access token.
// Returns null when Google refuses the grant (expired/revoked token).
async function getAccessToken(): Promise<{ token: string; scope: string } | null> {
  const result = await googleRequest('https://oauth2.googleapis.com/token', 'POST', null, {
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.body) as { access_token?: string; scope?: string };
    if (typeof parsed.access_token !== 'string' || !parsed.access_token) return null;
    return { token: parsed.access_token, scope: parsed.scope ?? '(none returned)' };
  } catch {
    return null;
  }
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
    const parsed = JSON.parse(result.body) as {
      error?: {
        message?: string;
        status?: string;
        details?: Array<{ reason?: string; domain?: string; metadata?: Record<string, string> }>;
      };
    };
    const err = parsed.error;
    if (err?.message) {
      // Google's details name the exact cause (e.g. SERVICE_DISABLED with
      // metadata.service) — surface them instead of the bare message.
      const detailBits = (err.details ?? [])
        .map((d) =>
          [d.reason, d.domain, d.metadata ? JSON.stringify(d.metadata) : ''].filter(Boolean).join(' '),
        )
        .filter(Boolean);
      const suffix = [err.status, ...detailBits].filter(Boolean).join(' | ');
      return suffix ? `${err.message} [${suffix}]` : err.message;
    }
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
    // 1. Exchange the stored refresh token for a fresh access token.
    const token = await getAccessToken();
    if (!token) {
      return {
        mode: 'failed',
        error: 'Could not get a Google access token. The refresh token may be expired or revoked — re-run the consent flow to get a fresh one.',
      };
    }
    const accessToken = token.token;
    const grantedScope = token.scope;

    // 2. Create the spreadsheet via the Drive API (not Sheets
    // spreadsheets.create). Google now returns 403 PERMISSION_DENIED for
    // service accounts calling spreadsheets.create directly, even with
    // the Sheets API enabled and a valid token; creating via Drive and
    // then filling it with the Sheets API is the working path.
    const driveCreateResult = await googleRequest(
      'https://www.googleapis.com/drive/v3/files',
      'POST',
      accessToken,
      { name: title, mimeType: 'application/vnd.google-apps.spreadsheet' },
    );
    if (!driveCreateResult.ok) {
      return {
        mode: 'failed',
        error: `drive-create: ${googleError(driveCreateResult, 'Could not create the spreadsheet file.')} [granted scope: ${grantedScope}]`,
      };
    }
    const created = JSON.parse(driveCreateResult.body) as { id?: string };
    const sheetId = created.id;
    if (!sheetId) {
      return { mode: 'failed', error: 'Google did not return a spreadsheet ID.' };
    }

    // 2b. Rename the default Sheet1 tab to "Box Score" and add "Timeline".
    const tabsResult = await googleRequest(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`,
      'POST',
      accessToken,
      {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId: 0, title: 'Box Score' },
              fields: 'title',
            },
          },
          { addSheet: { properties: { title: 'Timeline' } } },
        ],
      },
    );
    if (!tabsResult.ok) {
      return {
        mode: 'failed',
        error: `tabs: ${googleError(tabsResult, 'Could not set up the spreadsheet tabs.')} [granted scope: ${grantedScope}]`,
      };
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
      return {
        mode: 'failed',
        error: `write: ${googleError(writeResult, 'Could not write the game data to the spreadsheet.')} [granted scope: ${grantedScope}]`,
      };
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
