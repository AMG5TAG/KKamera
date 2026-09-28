import { Client as FtpClient } from "basic-ftp";
import { createClient as createWebdavClient } from "webdav";
import { Readable } from "stream";
import dns from "dns";
import net from "net";
import type { ConnectionOptions as TlsConnectionOptions } from "tls";
import { db } from "@workspace/db";
import { cloudConnectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";
import { encrypt, decrypt, decryptCredential } from "./crypto.js";
import { isPrivateIp, SafeHttpAgent, SafeHttpsAgent } from "./ssrf.js";
import { sanitizeFileName } from "./fileNames.js";
import { nextcloudDavUrl, webdavBaseUrl } from "./nextcloud.js";
import {
  CONTROL_REQUEST_TIMEOUT_MS,
  DROPBOX_CHUNK_SIZE,
  DROPBOX_SESSION_THRESHOLD,
  RemoteHttpError,
  chunkRanges,
  dropboxApiArg,
  dropboxPath,
  isTlsCertError,
  isTlsUnsupportedError,
  publicUploadError,
  uploadDeadlineMs,
} from "./cloudUploadPolicy.js";

// ─── SSRF guard ───────────────────────────────────────────────────────────────
// User-supplied FTP/WebDAV hosts are attacker-controlled. We resolve the host and
// reject private targets. IP classification and the connect-time agents live in
// ./ssrf.js (unit-tested).

function hostNotAllowed(message: string): Error {
  return Object.assign(new Error(message), { code: "HOST_NOT_ALLOWED" });
}

/**
 * Throw unless `rawHost` (a bare hostname or a full URL) resolves only to public
 * addresses. Returns the hostname and the first resolved IP; FTP pins that IP
 * for the connect, WebDAV re-validates on every connection via the Safe agents.
 */
async function assertPublicHost(rawHost: string): Promise<{ hostname: string; pinnedIp: string }> {
  let hostname = rawHost.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(hostname)) {
    try { hostname = new URL(hostname).hostname; } catch { /* treat as bare host */ }
  }
  hostname = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!hostname) throw hostNotAllowed("Invalid host");

  const lowered = hostname.toLowerCase();
  if (
    lowered === "localhost" ||
    lowered.endsWith(".localhost") ||
    lowered.endsWith(".local") ||
    lowered.endsWith(".internal")
  ) {
    throw hostNotAllowed("Host not allowed");
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw hostNotAllowed("Host points to a private address and is not allowed");
    return { hostname, pinnedIp: hostname };
  }

  const addrs = await dns.promises.lookup(hostname, { all: true });
  if (addrs.length === 0) throw new Error("Host did not resolve");
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw hostNotAllowed("Host resolves to a private address and is not allowed");
  }
  return { hostname, pinnedIp: addrs[0]!.address };
}

// ─── Deadlines ────────────────────────────────────────────────────────────────
// Every outbound call is bounded: a remote that accepts the connection and then
// stalls must not pin an upload slot (and the file's Buffer) forever.

/** `signal` combined with a per-request timeout for small control calls. */
function controlSignal(signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/** Throw a RemoteHttpError (status kept for error mapping, body only logged). */
async function failResponse(res: Response, what: string): Promise<never> {
  const body = await res.text().catch(() => res.statusText);
  throw new RemoteHttpError(`${what} failed: ${res.status} ${body.slice(0, 500)}`, res.status);
}

export interface CloudConn {
  id: number;
  type: string;
  host: string | null;
  port: number | null;
  username: string | null;
  passwordEncrypted: string | null;
  accessTokenEncrypted: string | null;
  refreshToken: string | null;
  tokenExpiry: Date | null;
  uploadPath: string | null;
}

export type UploadResult = { connectionId: number; success: boolean; error?: string };


// ─── OAuth Auto-Refresh ───────────────────────────────────────────────────────

const OAUTH_CONFIG: Record<string, { tokenUrl: string; clientIdEnv: string; clientSecretEnv: string }> = {
  googledrive: {
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
  },
  onedrive: {
    // Must match the authority used in routes/oauth.ts (/common) so refresh
    // works for both personal and work/school accounts.
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    clientIdEnv: "ONEDRIVE_CLIENT_ID",
    clientSecretEnv: "ONEDRIVE_CLIENT_SECRET",
  },
  dropbox: {
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    clientIdEnv: "DROPBOX_CLIENT_ID",
    clientSecretEnv: "DROPBOX_CLIENT_SECRET",
  },
};

/** Refresh the stored access token using the refresh token and persist the new values. */
async function refreshAndPersistToken(conn: CloudConn, signal?: AbortSignal): Promise<string> {
  const cfg = OAUTH_CONFIG[conn.type];
  if (!cfg) throw new Error(`No refresh config for provider: ${conn.type}`);
  if (!conn.refreshToken) {
    throw Object.assign(new Error(`No refresh token stored for connection ${conn.id} — re-connect the account.`), { code: "REAUTH" });
  }

  const refreshTok = decryptCredential(conn.refreshToken);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTok,
    client_id: process.env[cfg.clientIdEnv] ?? "",
    client_secret: process.env[cfg.clientSecretEnv] ?? "",
  });

  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: controlSignal(signal),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    // A rejected refresh token (400 invalid_grant / 401) means the user must
    // re-connect; surface it as an auth failure rather than a generic one.
    throw Object.assign(new Error(`Token refresh failed (${res.status}): ${text.slice(0, 500)}`), {
      code: res.status === 400 || res.status === 401 ? "REAUTH" : undefined,
    });
  }

  const data = await res.json() as { access_token: string; expires_in?: number; refresh_token?: string };
  const newExpiry = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
  const encryptedAccess = encrypt(data.access_token);

  await db.update(cloudConnectionsTable).set({
    accessTokenEncrypted: encryptedAccess,
    tokenExpiry: newExpiry,
    ...(data.refresh_token ? { refreshToken: encrypt(data.refresh_token) } : {}),
  }).where(eq(cloudConnectionsTable.id, conn.id));

  // Keep the local object in sync for any subsequent reads
  conn.accessTokenEncrypted = encryptedAccess;
  conn.tokenExpiry = newExpiry;
  if (data.refresh_token) conn.refreshToken = encrypt(data.refresh_token);

  logger.info({ connectionId: conn.id, type: conn.type }, "OAuth token auto-refreshed");
  return data.access_token;
}

/**
 * Return a valid decrypted access token. Automatically refreshes when the
 * token is absent, already expired, or expiring within the next 5 minutes.
 */
async function getAccessToken(conn: CloudConn, signal?: AbortSignal): Promise<string> {
  const raw = decryptCredential(conn.accessTokenEncrypted);
  const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000);
  const expiringSoon = conn.tokenExpiry != null && conn.tokenExpiry < fiveMinFromNow;

  if ((!raw || expiringSoon) && conn.refreshToken) {
    return refreshAndPersistToken(conn, signal);
  }

  if (!raw) {
    throw Object.assign(new Error(`No access token for ${conn.type} connection (id=${conn.id}). Please re-connect the account.`), { code: "REAUTH" });
  }
  return raw;
}

// ─── FTP ──────────────────────────────────────────────────────────────────────

/**
 * Connect and log in an FTP client, preferring a certificate-validated FTPS
 * (AUTH TLS) session. Steps are run individually (rather than via
 * `client.access`) so each failure can be attributed to its phase:
 *
 *  - The socket is pinned to the validated public IP (DNS-rebinding guard), but
 *    the certificate is checked against the *hostname* the user entered
 *    (`servername`, which Node's tls uses for SNI and checkServerIdentity).
 *    Previously the cert was checked against the IP, which always failed, so
 *    every FTPS session silently fell back to an unverified one.
 *  - Only a TLS certificate error falls back to an unverified (still encrypted)
 *    session — e.g. a NAS with a self-signed cert. Auth/network errors are
 *    never retried: each retry is another login and trips fail2ban.
 *  - Plaintext is used only when the server refuses AUTH TLS *and* an operator
 *    opted in via ALLOW_INSECURE_FTP; otherwise it fails closed.
 */
async function ftpConnect(client: FtpClient, conn: CloudConn): Promise<void> {
  const { hostname, pinnedIp } = await assertPublicHost(conn.host!);
  const port = conn.port ?? 21;
  const user = conn.username ?? "anonymous";
  const password = decryptCredential(conn.passwordEncrypted);
  // SNI / identity checks need a DNS name; an IP literal host is checked as-is.
  const servername = net.isIP(hostname) ? undefined : hostname;
  const tlsOpts = (rejectUnauthorized: boolean): TlsConnectionOptions => ({
    // `host` is also reused by basic-ftp for the TLS data connections.
    host: pinnedIp,
    ...(servername ? { servername } : {}),
    rejectUnauthorized,
  });

  await client.connect(pinnedIp, port);
  try {
    await client.useTLS(tlsOpts(true));
  } catch (err) {
    if (isTlsCertError(err)) {
      // Nothing has been sent yet (no USER/PASS), so reconnecting costs no login.
      await client.connect(pinnedIp, port);
      await client.useTLS(tlsOpts(false));
      logger.warn({ connectionId: conn.id, code: (err as any).code }, "FTPS certificate not validated — encrypted but unauthenticated");
    } else if (isTlsUnsupportedError(err)) {
      if (process.env["ALLOW_INSECURE_FTP"] !== "true") {
        throw new Error("FTP server does not support TLS. Refusing to send credentials over an unencrypted connection.");
      }
      await client.connect(pinnedIp, port);
      logger.warn({ connectionId: conn.id }, "FTP connection is UNENCRYPTED (ALLOW_INSECURE_FTP opt-in)");
    } else {
      throw err;
    }
  }
  // Backstop: confirm the socket's actual peer is public before sending credentials.
  const remote = client.ftp.socket?.remoteAddress;
  if (remote && isPrivateIp(remote)) {
    throw hostNotAllowed("FTP connection resolved to a private address");
  }
  await client.sendIgnoringError("OPTS UTF8 ON");
  await client.login(user, password);
  await client.useDefaultSettings();
}

/**
 * Run `fn` with an FTP client that is force-closed when `signal` aborts.
 * basic-ftp has its own per-socket inactivity timeout, but a server trickling
 * bytes could keep a transfer alive indefinitely; closing the client rejects
 * the in-flight task.
 */
async function withFtpClient<T>(timeoutMs: number, signal: AbortSignal, fn: (client: FtpClient) => Promise<T>): Promise<T> {
  const client = new FtpClient(timeoutMs);
  const onAbort = () => client.close();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) throw signal.reason;
    return await fn(client);
  } catch (err) {
    // Report the deadline, not basic-ftp's "User closed client during task".
    if (signal.aborted) throw signal.reason;
    throw err;
  } finally {
    signal.removeEventListener("abort", onAbort);
    client.close();
  }
}

async function uploadFtp(conn: CloudConn, buf: Buffer, fileName: string, signal: AbortSignal): Promise<void> {
  await withFtpClient(20_000, signal, async (client) => {
    await ftpConnect(client, conn);
    const dir = conn.uploadPath ?? "/KKamera";
    await client.ensureDir(dir);
    await client.uploadFrom(Readable.from(buf), `${dir}/${fileName}`);
  });
}

async function testFtp(conn: CloudConn): Promise<{ success: boolean; message: string }> {
  try {
    await withFtpClient(10_000, AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS), async (client) => {
      await ftpConnect(client, conn);
      await client.list("/");
    });
    return { success: true, message: "FTP connection successful" };
  } catch (err: any) {
    // Don't surface raw internal errors (resolver text, private-IP guard messages,
    // remote hostnames) to the client — log them, return actionable guidance.
    logger.warn({ err, connectionId: conn.id }, "FTP connection test failed");
    return { success: false, message: "Could not connect. Check the host, port, credentials, and that the server supports TLS (FTPS)." };
  }
}

// ─── WebDAV (also the transport for Nextcloud) ────────────────────────────────

/**
 * Build a WebDAV client for `baseUrl` after checking the host is public.
 * `baseUrl` is the DAV collection root — the connection's host (+ port) for a
 * plain WebDAV server, the derived `/remote.php/dav/files/<user>` endpoint for
 * Nextcloud.
 *
 * The client gets its own Safe agents, locked to the base URL's hostname: every
 * connection re-validates the target (IP literal, resolved addresses, and the
 * socket's real peer), and any redirect to a different host fails outright.
 * webdav 5 → node-fetch 3 follows redirects itself and re-sends PUT bodies on
 * 307/308; there is no per-client redirect switch, so the agents are the guard.
 * Call `dispose()` when done to free the agents' sockets.
 */
async function webdavClientFor(conn: CloudConn, baseUrl: string) {
  const { hostname } = await assertPublicHost(baseUrl);
  const pass = decryptCredential(conn.passwordEncrypted);
  const httpAgent = new SafeHttpAgent({ allowedHost: hostname });
  const httpsAgent = new SafeHttpsAgent({ allowedHost: hostname });
  const client = createWebdavClient(baseUrl, {
    username: conn.username ?? undefined,
    password: pass || undefined,
    httpAgent,
    httpsAgent,
  });
  return {
    client,
    dispose: () => { httpAgent.destroy(); httpsAgent.destroy(); },
  };
}

async function uploadWebdavTo(conn: CloudConn, baseUrl: string, buf: Buffer, fileName: string, signal: AbortSignal): Promise<void> {
  const { client, dispose } = await webdavClientFor(conn, baseUrl);
  try {
    const dir = conn.uploadPath ?? "/KKamera";
    if (!(await client.exists(dir, { signal: controlSignal(signal) }))) {
      await client.createDirectory(dir, { recursive: true, signal: controlSignal(signal) });
    }
    const ok = await client.putFileContents(`${dir}/${fileName}`, buf, { overwrite: true, signal });
    if (ok === false) throw new Error("WebDAV server refused the upload");
  } finally {
    dispose();
  }
}

/**
 * Probe a DAV endpoint. `label` names the service in the success text and
 * `failureHint` is the (deliberately generic) guidance shown on failure — raw
 * errors carry resolver text and internal hostnames, so they only go to the log.
 */
async function testWebdavAt(
  conn: CloudConn,
  baseUrl: string,
  label: string,
  failureHint: string,
): Promise<{ success: boolean; message: string }> {
  let dispose: (() => void) | undefined;
  try {
    const dav = await webdavClientFor(conn, baseUrl);
    dispose = dav.dispose;
    const exists = await dav.client.exists(conn.uploadPath ?? "/", { signal: controlSignal() });
    return {
      success: true,
      message: exists
        ? `${label} folder exists and is accessible`
        : `${label} connected — upload folder will be created on first upload`,
    };
  } catch (err: any) {
    logger.warn({ err, connectionId: conn.id, type: conn.type }, `${label} connection test failed`);
    return { success: false, message: failureHint };
  } finally {
    dispose?.();
  }
}

async function uploadWebdav(conn: CloudConn, buf: Buffer, fileName: string, signal: AbortSignal): Promise<void> {
  await uploadWebdavTo(conn, webdavBaseUrl(conn.host, conn.port), buf, fileName, signal);
}

async function testWebdav(conn: CloudConn): Promise<{ success: boolean; message: string }> {
  const hint = "Could not connect. Check the URL (including port), credentials, and upload path.";
  let baseUrl: string;
  try {
    baseUrl = webdavBaseUrl(conn.host, conn.port);
  } catch (err: any) {
    // Only fails on missing/malformed user input — safe to hand back verbatim.
    return { success: false, message: String(err?.message ?? hint) };
  }
  return testWebdavAt(conn, baseUrl, "WebDAV", hint);
}

// ─── Nextcloud ────────────────────────────────────────────────────────────────
// Nextcloud is WebDAV underneath, but the user only knows their server URL —
// the files endpoint is derived from it and the username (see lib/nextcloud.ts).
// Credentials should be an app password (Settings → Security), which is what
// keeps working when the account has 2FA enabled.

async function uploadNextcloud(conn: CloudConn, buf: Buffer, fileName: string, signal: AbortSignal): Promise<void> {
  await uploadWebdavTo(conn, nextcloudDavUrl(conn.host, conn.username, conn.port), buf, fileName, signal);
}

async function testNextcloud(conn: CloudConn): Promise<{ success: boolean; message: string }> {
  let davUrl: string;
  try {
    davUrl = nextcloudDavUrl(conn.host, conn.username, conn.port);
  } catch (err: any) {
    // Derivation only fails on missing/malformed user input, so this message is
    // safe (and useful) to hand back verbatim.
    return { success: false, message: String(err?.message ?? "Invalid Nextcloud server URL") };
  }
  return testWebdavAt(
    conn,
    davUrl,
    "Nextcloud",
    "Could not connect. Check the server URL and username, and make sure the password is an app password (Nextcloud → Settings → Security → Create new app password).",
  );
}

// ─── Google Drive ─────────────────────────────────────────────────────────────

async function ensureDriveFolder(token: string, folderName: string, signal: AbortSignal): Promise<string> {
  // Escape single quotes and backslashes per Google Drive query syntax so the
  // folder name can't break out of the quoted string in the `q` parameter.
  const escaped = folderName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const search = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` }, signal: controlSignal(signal) }
  );
  if (!search.ok) await failResponse(search, "Drive folder lookup");
  const data = await search.json() as any;
  if (data.files?.length > 0) return data.files[0].id as string;
  const create = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder" }),
    signal: controlSignal(signal),
  });
  if (!create.ok) await failResponse(create, "Drive folder create");
  const folder = await create.json() as any;
  if (!folder.id) throw new Error(`Could not create Drive folder: ${JSON.stringify(folder)}`);
  return folder.id as string;
}

async function uploadGoogleDrive(conn: CloudConn, buf: Buffer, fileName: string, mimeType: string, signal: AbortSignal): Promise<void> {
  const token = await getAccessToken(conn, signal);
  const folderName = (conn.uploadPath ?? "/KKamera").replace(/^\/+/, "") || "KKamera";
  const folderId = await ensureDriveFolder(token, folderName, signal);
  const boundary = "kkamera_boundary_314159";
  const meta = JSON.stringify({ name: fileName, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary="${boundary}"`,
    },
    body,
    signal,
  });
  if (!res.ok) await failResponse(res, "Google Drive upload");
}

async function testGoogleDrive(conn: CloudConn): Promise<{ success: boolean; message: string }> {
  try {
    const signal = controlSignal();
    const token = await getAccessToken(conn, signal);
    const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) return { success: false, message: `Token invalid (${res.status}) — re-connect your Google account.` };
    const data = await res.json() as any;
    return { success: true, message: `Connected as ${data.user?.displayName ?? "Google user"}` };
  } catch (err: any) {
    logger.warn({ err, connectionId: conn.id, type: conn.type }, "Cloud connection test failed");
    return { success: false, message: "Could not verify the connection. Please re-connect the account." };
  }
}

// ─── OneDrive ─────────────────────────────────────────────────────────────────

async function uploadOneDrive(conn: CloudConn, buf: Buffer, fileName: string, signal: AbortSignal): Promise<void> {
  const token = await getAccessToken(conn, signal);
  const dir = (conn.uploadPath ?? "/KKamera").replace(/^\/+/, "");
  const url = `https://graph.microsoft.com/v1.0/me/drive/root:/${dir}/${fileName}:/content`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: buf,
    signal,
  });
  if (!res.ok) await failResponse(res, "OneDrive upload");
}

async function testOneDrive(conn: CloudConn): Promise<{ success: boolean; message: string }> {
  try {
    const signal = controlSignal();
    const token = await getAccessToken(conn, signal);
    // /me requires User.Read; the token only carries Files.ReadWrite, so probe the drive instead
    const res = await fetch("https://graph.microsoft.com/v1.0/me/drive", {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) return { success: false, message: `Token invalid (${res.status}) — re-connect your Microsoft account.` };
    const data = await res.json() as any;
    return { success: true, message: `Connected as ${data.owner?.user?.displayName ?? "Microsoft user"}` };
  } catch (err: any) {
    logger.warn({ err, connectionId: conn.id, type: conn.type }, "Cloud connection test failed");
    return { success: false, message: "Could not verify the connection. Please re-connect the account." };
  }
}

// ─── Dropbox ──────────────────────────────────────────────────────────────────

const DROPBOX_CONTENT = "https://content.dropboxapi.com/2/files";

async function dropboxContentCall(token: string, endpoint: string, arg: unknown, body: Buffer, signal: AbortSignal): Promise<any> {
  const res = await fetch(`${DROPBOX_CONTENT}/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": dropboxApiArg(arg),
    },
    body,
    signal,
  });
  if (!res.ok) await failResponse(res, `Dropbox ${endpoint}`);
  return res.json().catch(() => ({}));
}

/**
 * Small files go up in one `files/upload` call. Anything above
 * DROPBOX_SESSION_THRESHOLD uses an upload session (start → append_v2 → finish)
 * in DROPBOX_CHUNK_SIZE pieces: single-call uploads are capped at 150 MB, and
 * smaller requests also survive a flaky link better.
 */
async function uploadDropbox(conn: CloudConn, buf: Buffer, fileName: string, signal: AbortSignal): Promise<void> {
  const token = await getAccessToken(conn, signal);
  const commit = { path: dropboxPath(conn.uploadPath, fileName), mode: "add", autorename: true };

  if (buf.length <= DROPBOX_SESSION_THRESHOLD) {
    await dropboxContentCall(token, "upload", commit, buf, signal);
    return;
  }

  const ranges = chunkRanges(buf.length, DROPBOX_CHUNK_SIZE);
  const [firstStart, firstEnd] = ranges[0]!;
  const started = await dropboxContentCall(token, "upload_session/start", { close: false }, buf.subarray(firstStart, firstEnd), signal);
  const sessionId = started?.session_id;
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Dropbox did not return an upload session id");

  for (let i = 1; i < ranges.length - 1; i++) {
    const [start, end] = ranges[i]!;
    await dropboxContentCall(token, "upload_session/append_v2", { cursor: { session_id: sessionId, offset: start }, close: false }, buf.subarray(start, end), signal);
  }

  // Finish carries the last chunk (or nothing, if the file fit in the first).
  const [lastStart, lastEnd] = ranges.length > 1 ? ranges[ranges.length - 1]! : [firstEnd, firstEnd];
  await dropboxContentCall(
    token,
    "upload_session/finish",
    { cursor: { session_id: sessionId, offset: lastStart }, commit },
    buf.subarray(lastStart, lastEnd),
    signal,
  );
}

async function testDropbox(conn: CloudConn): Promise<{ success: boolean; message: string }> {
  try {
    const signal = controlSignal();
    const token = await getAccessToken(conn, signal);
    const res = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) return { success: false, message: `Token invalid (${res.status}) — re-connect your Dropbox account.` };
    const data = await res.json() as any;
    return { success: true, message: `Connected as ${data.name?.display_name ?? "Dropbox user"}` };
  } catch (err: any) {
    logger.warn({ err, connectionId: conn.id, type: conn.type }, "Cloud connection test failed");
    return { success: false, message: "Could not verify the connection. Please re-connect the account." };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function uploadToCloud(conn: CloudConn, buf: Buffer, rawFileName: string, mimeType: string): Promise<UploadResult> {
  const fileName = sanitizeFileName(rawFileName);
  // One overall deadline per provider upload, scaled with size and capped
  // (see uploadDeadlineMs) so a stalled remote always frees the upload slot.
  const deadlineMs = uploadDeadlineMs(buf.length);
  const signal = AbortSignal.timeout(deadlineMs);
  try {
    switch (conn.type) {
      case "ftp":         await uploadFtp(conn, buf, fileName, signal); break;
      case "webdav":      await uploadWebdav(conn, buf, fileName, signal); break;
      case "nextcloud":   await uploadNextcloud(conn, buf, fileName, signal); break;
      case "googledrive": await uploadGoogleDrive(conn, buf, fileName, mimeType, signal); break;
      case "onedrive":    await uploadOneDrive(conn, buf, fileName, signal); break;
      case "dropbox":     await uploadDropbox(conn, buf, fileName, signal); break;
      default: throw new Error(`Unknown connection type: ${conn.type}`);
    }
    return { connectionId: conn.id, success: true };
  } catch (err: any) {
    // Full detail (remote status/body, resolver text, IPs) stays in the log;
    // the client — and the stored upload record — only get a generic message.
    logger.warn({ err, connectionId: conn.id, type: conn.type, deadlineMs, bytes: buf.length }, "Cloud upload failed");
    return { connectionId: conn.id, success: false, error: publicUploadError(conn.type, err) };
  }
}

export async function testCloudConnection(conn: CloudConn): Promise<{ success: boolean; message: string }> {
  // Host-based types run their own probe even without a host — each returns a
  // message pointing at the field that is actually missing.
  const hostBased = conn.type === "ftp" || conn.type === "webdav" || conn.type === "nextcloud";
  if (!conn.host && !conn.accessTokenEncrypted && !hostBased) {
    return { success: false, message: "No credentials configured for this connection." };
  }
  switch (conn.type) {
    case "ftp":         return testFtp(conn);
    case "webdav":      return testWebdav(conn);
    case "nextcloud":   return testNextcloud(conn);
    case "googledrive": return testGoogleDrive(conn);
    case "onedrive":    return testOneDrive(conn);
    case "dropbox":     return testDropbox(conn);
    default: return { success: false, message: `Unknown type: ${conn.type}` };
  }
}
