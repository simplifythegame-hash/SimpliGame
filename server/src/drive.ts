import https from 'https';

// Per-user Google Drive — video import storage.
//
// Imported videos live in EACH USER'S OWN Google Drive (tied to them,
// not the app owner). Each coach connects their own Google account
// once from the Account screen; the connection uses the drive.file
// scope ONLY, so SimpliGame can see and touch nothing in their Drive
// except the files it created itself.
//
// This is a separate identity from the app-level Sheets OAuth in
// sheets.ts (one shared refresh token in an env var, acting as the
// app's export account). Here the refresh token lives on the user row
// (users.google_refresh_token, migration 011) and is exchanged for a
// fresh access token on every use, server-side only. The refresh token
// is NEVER returned by any API response and never logged.
//
// Uploads are resumable and go browser → Google directly: the server
// initiates the resumable session with the user's access token and
// hands the session URL to the browser, which PUTs the file in chunks.
// Video bytes never pass through Render.
//
// Env vars (shared OAuth client with Sheets):
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
//   PUBLIC_URL (redirect URI base; defaults to the production origin)

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export function isDriveConfigured(): boolean {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

function publicOrigin(): string {
  return (process.env.PUBLIC_URL ?? 'https://simpligame.onrender.com').replace(/\/+$/, '');
}

export function googleRedirectUri(): string {
  return `${publicOrigin()}/api/auth/google/callback`;
}

// ------------------------------------------------------------- HTTP core
type GoogleResult = { ok: boolean; status: number; body: string; headers: Record<string, string | string[] | undefined> };

function googleRequest(
  url: string,
  method: string,
  accessToken: string | null,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<GoogleResult> {
  const payload = body === null || body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve) => {
    const headers: Record<string, string> = { ...extraHeaders };
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
        resolve({
          ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
          status: res.statusCode ?? 500,
          body: data,
          headers: res.headers,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Google API request timed out.'));
    });
    req.on('error', (err) => {
      resolve({ ok: false, status: 0, body: JSON.stringify({ error: err.message }), headers: {} });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function googleError(result: GoogleResult, fallback: string): string {
  try {
    const parsed = JSON.parse(result.body) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message) {
      return parsed.error.status
        ? `${parsed.error.message} [${parsed.error.status}]`
        : parsed.error.message;
    }
  } catch {
    // Keep the fallback.
  }
  return `${fallback} (HTTP ${result.status})`;
}

// ---------------------------------------------------------------- OAuth
export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
}

/** Exchange an authorization code (from the consent callback) for tokens. */
export async function exchangeCodeForTokens(code: string): Promise<GoogleTokens | null> {
  const result = await googleRequest('https://oauth2.googleapis.com/token', 'POST', null, {
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: googleRedirectUri(),
  });
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.body) as { access_token?: string; refresh_token?: string };
    if (typeof parsed.access_token !== 'string' || !parsed.access_token) return null;
    return {
      accessToken: parsed.access_token,
      refreshToken:
        typeof parsed.refresh_token === 'string' && parsed.refresh_token ? parsed.refresh_token : null,
    };
  } catch {
    return null;
  }
}

/** Exchange a stored per-user refresh token for a fresh access token.
 *  Returns null when Google refuses the grant (revoked/disconnected). */
export async function refreshDriveAccessToken(refreshToken: string): Promise<string | null> {
  const result = await googleRequest('https://oauth2.googleapis.com/token', 'POST', null, {
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.body) as { access_token?: string };
    return typeof parsed.access_token === 'string' && parsed.access_token ? parsed.access_token : null;
  } catch {
    return null;
  }
}

/** The connected account's email (for "Connected as …" display). The
 *  consent request includes the basic `email` scope for exactly this. */
export async function getGoogleUserEmail(accessToken: string): Promise<string | null> {
  const result = await googleRequest('https://www.googleapis.com/oauth2/v3/userinfo', 'GET', accessToken, null);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.body) as { email?: string };
    return typeof parsed.email === 'string' && parsed.email ? parsed.email : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Drive
const SIMPLIGAME_FOLDER_NAME = 'SimpliGame';

/** Find the app's folder in the user's Drive, creating it on first use.
 *  With drive.file scope, files.list only returns files this app
 *  created — which is all we ever look for. */
export async function findOrCreateSimpliGameFolder(
  accessToken: string,
): Promise<{ ok: true; folderId: string } | { ok: false; error: string }> {
  const q = encodeURIComponent(
    `name = '${SIMPLIGAME_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  );
  const list = await googleRequest(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`,
    'GET',
    accessToken,
    null,
  );
  if (!list.ok) {
    return { ok: false, error: googleError(list, 'Could not look for the SimpliGame folder in Drive.') };
  }
  try {
    const parsed = JSON.parse(list.body) as { files?: Array<{ id?: string }> };
    const existing = parsed.files?.find((f) => typeof f.id === 'string' && f.id);
    if (existing?.id) return { ok: true, folderId: existing.id };
  } catch {
    // Fall through to creation — an unparseable list is treated as empty.
  }
  const created = await googleRequest('https://www.googleapis.com/drive/v3/files', 'POST', accessToken, {
    name: SIMPLIGAME_FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder',
  });
  if (!created.ok) {
    return { ok: false, error: googleError(created, 'Could not create the SimpliGame folder in Drive.') };
  }
  try {
    const parsed = JSON.parse(created.body) as { id?: string };
    if (parsed.id) return { ok: true, folderId: parsed.id };
  } catch {
    // Fall through to the error below.
  }
  return { ok: false, error: 'Google did not return a folder ID.' };
}

/** Initiate a Drive resumable upload session for a new file in the
 *  SimpliGame folder. Returns the session URL the browser PUTs chunks
 *  to (the URL itself is the capability — no auth header is needed or
 *  allowed on the chunk requests). */
export async function initiateResumableUpload(
  accessToken: string,
  input: { folderId: string; name: string; mimeType: string; sizeBytes: number },
): Promise<{ ok: true; uploadUrl: string } | { ok: false; error: string }> {
  const result = await googleRequest(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    'POST',
    accessToken,
    { name: input.name, parents: [input.folderId], mimeType: input.mimeType },
    {
      'X-Upload-Content-Type': input.mimeType,
      'X-Upload-Content-Length': String(input.sizeBytes),
    },
  );
  if (!result.ok) {
    return { ok: false, error: googleError(result, 'Could not start the Drive upload.') };
  }
  const location = result.headers.location;
  if (typeof location !== 'string' || !location) {
    return { ok: false, error: 'Google did not return an upload session URL.' };
  }
  return { ok: true, uploadUrl: location };
}

export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  trashed: boolean;
}

/** Verify a file exists (used when the browser reports an upload done). */
export async function getDriveFile(accessToken: string, fileId: string): Promise<DriveFileInfo | null> {
  const result = await googleRequest(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,trashed`,
    'GET',
    accessToken,
    null,
  );
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.body) as {
      id?: string;
      name?: string;
      mimeType?: string;
      size?: string;
      trashed?: boolean;
    };
    if (!parsed.id) return null;
    return {
      id: parsed.id,
      name: parsed.name ?? '',
      mimeType: parsed.mimeType ?? '',
      sizeBytes: Number(parsed.size ?? 0) || 0,
      trashed: parsed.trashed === true,
    };
  } catch {
    return null;
  }
}

/** Fallback for /complete when the browser didn't report a file id:
 *  find the newest file with this name inside the SimpliGame folder. */
export async function findDriveFileInFolder(
  accessToken: string,
  folderId: string,
  name: string,
): Promise<DriveFileInfo | null> {
  const q = encodeURIComponent(
    `name = '${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`,
  );
  const list = await googleRequest(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size,createdTime)&orderBy=createdTime desc&pageSize=1`,
    'GET',
    accessToken,
    null,
  );
  if (!list.ok) return null;
  try {
    const parsed = JSON.parse(list.body) as {
      files?: Array<{ id?: string; name?: string; mimeType?: string; size?: string }>;
    };
    const file = parsed.files?.[0];
    if (!file?.id) return null;
    return {
      id: file.id,
      name: file.name ?? '',
      mimeType: file.mimeType ?? '',
      sizeBytes: Number(file.size ?? 0) || 0,
      trashed: false,
    };
  } catch {
    return null;
  }
}

/** Delete a file from Drive. Returns false when Google refuses — the
 *  caller decides whether that is fatal (it is not: the app row is the
 *  source of truth for the library). */
export async function deleteDriveFile(accessToken: string, fileId: string): Promise<boolean> {
  const result = await googleRequest(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
    'DELETE',
    accessToken,
    null,
  );
  return result.ok || result.status === 404;
}
