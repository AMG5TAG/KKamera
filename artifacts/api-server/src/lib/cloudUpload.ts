import { Client as FtpClient } from "basic-ftp";
import { createClient as createWebdavClient } from "webdav";
import fs from "fs";
import type { FileHandle } from "fs/promises";
import dns from "dns";
import { randomUUID } from "crypto";
import net from "net";
import type { ConnectionOptions as TlsConnectionOptions } from "tls";
import { db } from "@workspace/db";
import { cloudConnectionsTable } from "@workspace/db";
import { and, eq, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { logger } from "./logger.js";
import { encrypt, decrypt, decryptCredential } from "./crypto.js";
import { isPrivateIp, SafeHttpAgent, SafeHttpsAgent } from "./ssrf.js";
import { sanitizeFileName } from "./fileNames.js";
import { nextcloudDavUrl, webdavBaseUrl } from "./nextcloud.js";
import {
  CONTROL_REQUEST_TIMEOUT_MS,
  DRIVE_CHUNK_SIZE,
  DRIVE_RESUMABLE_THRESHOLD,
  DROPBOX_CHUNK_SIZE,
  DROPBOX_SESSION_THRESHOLD,
  ONEDRIVE_CHUNK_SIZE,
  ONEDRIVE_SESSION_THRESHOLD,
  RemoteHttpError,
  chunkRanges,
  driveFolderQuery,
  driveNextOffset,
  dropboxApiArg,
  dropboxPath,
  isTlsCertError,
  isTlsUnsupportedError,
  joinRemotePath,
  normalizeUploadPath,
  oneDriveItemPath,
  publicUploadError,
  uploadDeadlineMs,
  uploadPathSegments,
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
// stalls must not pin an upload slot (and its open file / chunk buffer) forever.

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

/**
 * The file to upload, on local disk (multer's temp file). Providers stream it
 * or read it one chunk at a time, so a large video is never held in memory
 * whole — only small single-request uploads read the file into a Buffer.
 */
export interface UploadSource {
  path: string;
  size: number;
}

/** Read the whole file — only for the small single-request paths (≤ 8 MB). */
function readSmallFile(src: UploadSource): Promise<Buffer> {
  return fs.promises.readFile(src.path);
}

/** Run `fn` with a read-only handle on the source file, always closed after. */
async function withSourceFile<T>(src: UploadSource, fn: (fh: FileHandle) => Promise<T>): Promise<T> {
  const fh = await fs.promises.open(src.path, "r");
  try {
    return await fn(fh);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Read bytes [start, end) — one chunk in memory at a time. */
async function readRange(fh: FileHandle, start: number, end: number): Promise<Buffer> {
  const len = end - start;
  const buf = Buffer.allocUnsafe(len);
  let off = 0;
  while (off < len) {
    const { bytesRead } = await fh.read(buf, off, len - off, start + off);
    if (bytesRead === 0) throw new Error("Upload file is shorter than expected");
    off += bytesRead;
  }
  return buf;
}


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

async function uploadFtp(conn: CloudConn, src: UploadSource, fileName: string, signal: AbortSignal): Promise<void> {
  await withFtpClient(20_000, signal, async (client) => {
    await ftpConnect(client, conn);
    // ensureDir() walks (creating as needed) into the directory and LEAVES the
    // session there, so the file is then stored by its bare name. Joining the
    // directory onto the name again doubled relative paths ("dir/dir/file").
    // "/dir" is absolute, "dir" is relative to the login's home, "" is home.
    const dir = normalizeUploadPath(conn.uploadPath);
    if (dir === "/") await client.cd("/");
    else if (dir) await client.ensureDir(dir);
    // Streamed from disk; destroyed on every path (incl. the deadline closing
    // the client mid-transfer) so the file descriptor is never leaked.
    const stream = fs.createReadStream(src.path);
    try {
      await client.uploadFrom(stream, fileName);
    } finally {
      stream.destroy();
    }
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

async function uploadWebdavTo(conn: CloudConn, baseUrl: string, src: UploadSource, fileName: string, signal: AbortSignal): Promise<void> {
  const { client, dispose } = await webdavClientFor(conn, baseUrl);
  try {
    const segments = uploadPathSegments(conn.uploadPath);
    const dir = "/" + segments.join("/");
    if (segments.length > 0 && !(await client.exists(dir, { signal: controlSignal(signal) }))) {
      await client.createDirectory(dir, { recursive: true, signal: controlSignal(signal) });
    }
    // Streamed from disk. webdav 5 skips Content-Length for a stream body (and
    // ignores its `contentLength` option then), so set the header explicitly —
    // many servers (nginx, some NAS firmware) refuse chunked PUTs. A stream
    // body also can't be re-sent, so node-fetch fails a 307/308 redirect
    // instead of following it (the host-locked agents already block cross-host
    // ones). Auth is Basic up-front (AuthType.Password), so there is no 401
    // challenge retry that would need to replay the body.
    const stream = fs.createReadStream(src.path);
    try {
      const ok = await client.putFileContents(joinRemotePath(segments, fileName), stream, {
        overwrite: true,
        signal,
        headers: { "Content-Length": String(src.size) },
      });
      if (ok === false) throw new Error("WebDAV server refused the upload");
    } finally {
      stream.destroy();
    }
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
    const exists = await dav.client.exists("/" + uploadPathSegments(conn.uploadPath).join("/"), { signal: controlSignal() });
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

async function uploadWebdav(conn: CloudConn, src: UploadSource, fileName: string, signal: AbortSignal): Promise<void> {
  await uploadWebdavTo(conn, webdavBaseUrl(conn.host, conn.port), src, fileName, signal);
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

async function uploadNextcloud(conn: CloudConn, src: UploadSource, fileName: string, signal: AbortSignal): Promise<void> {
  await uploadWebdavTo(conn, nextcloudDavUrl(conn.host, conn.username, conn.port), src, fileName, signal);
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

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
/** How long a resolved folder id is reused before it is looked up again. */
const DRIVE_FOLDER_TTL_MS = 10 * 60_000;

/** `${connectionId}:${path}` → resolved folder id. */
const driveFolderCache = new Map<string, { id: string; expires: number }>();
/** Per-key tail of the in-flight folder resolutions (in-process mutex). */
const driveFolderLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier call for the same `key` has settled. Two photos
 * uploaded at once to a fresh connection would otherwise both miss the lookup
 * and both create "KKamera".
 */
async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = driveFolderLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  driveFolderLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (driveFolderLocks.get(key) === tail) driveFolderLocks.delete(key);
  }
}

/** Oldest non-trashed folder named `name` directly under `parentId`, if any. */
async function findDriveFolder(token: string, name: string, parentId: string, signal: AbortSignal): Promise<string | null> {
  const qs = new URLSearchParams({
    q: driveFolderQuery(name, parentId),
    fields: "files(id,createdTime)",
    orderBy: "createdTime",
    pageSize: "10",
    spaces: "drive",
  });
  const res = await fetch(`${DRIVE_API}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controlSignal(signal),
  });
  if (!res.ok) await failResponse(res, "Drive folder lookup");
  const data = await res.json() as { files?: Array<{ id?: string }> };
  return data.files?.find((f) => typeof f.id === "string")?.id ?? null;
}

async function findOrCreateDriveFolder(token: string, name: string, parentId: string, signal: AbortSignal): Promise<string> {
  const found = await findDriveFolder(token, name, parentId, signal);
  if (found) return found;
  const create = await fetch(`${DRIVE_API}?fields=id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: DRIVE_FOLDER_MIME, parents: [parentId] }),
    signal: controlSignal(signal),
  });
  if (!create.ok) await failResponse(create, "Drive folder create");
  const folder = await create.json() as { id?: string };
  if (!folder.id) throw new Error("Drive folder create returned no id");
  // Another server instance may have raced us to the same folder. Settle on
  // the oldest one so every later upload converges on a single folder.
  const oldest = await findDriveFolder(token, name, parentId, signal).catch(() => null);
  return oldest ?? folder.id;
}

/**
 * Resolve (creating as needed) the nested folder for `segments`, one level at
 * a time from My Drive's root — "/Photos/KKamera" is a "KKamera" folder inside
 * "Photos", not one folder with a slash in its name. Results are cached per
 * connection + path for a short TTL, and resolution is serialised per key.
 *
 * With the drive.file scope Drive only lists folders this app created, so a
 * "Photos" folder the user made by hand is not reused — a new one is created.
 */
async function resolveDriveFolder(connId: number, token: string, segments: string[], signal: AbortSignal): Promise<string> {
  if (segments.length === 0) return "root";
  const key = `${connId}:${segments.join("/")}`;
  const hit = driveFolderCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.id;
  return withKeyLock(key, async () => {
    const again = driveFolderCache.get(key);
    if (again && again.expires > Date.now()) return again.id;
    let parentId = "root";
    for (const name of segments) {
      parentId = await findOrCreateDriveFolder(token, name, parentId, signal);
    }
    driveFolderCache.set(key, { id: parentId, expires: Date.now() + DRIVE_FOLDER_TTL_MS });
    return parentId;
  });
}

async function driveMultipartUpload(token: string, meta: object, buf: Buffer, mimeType: string, signal: AbortSignal): Promise<void> {
  const boundary = `kkamera_${randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
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

/**
 * Resumable upload: open a session, then PUT DRIVE_CHUNK_SIZE pieces with
 * Content-Range. Each 308 "Resume Incomplete" reports how much Google has
 * persisted (Range: bytes=0-N) and the next chunk starts there, so a partially
 * accepted chunk is re-sent from the right offset rather than assumed done.
 */
async function driveResumableUpload(token: string, meta: object, src: UploadSource, mimeType: string, signal: AbortSignal): Promise<void> {
  const total = src.size;
  const init = await fetch(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(total),
    },
    body: JSON.stringify(meta),
    signal: controlSignal(signal),
  });
  if (!init.ok) await failResponse(init, "Google Drive resumable start");
  const sessionUrl = init.headers.get("location");
  if (!sessionUrl || !sessionUrl.startsWith("https://www.googleapis.com/")) {
    throw new Error("Google Drive did not return a resumable session URL");
  }

  const done = await withSourceFile(src, async (fh) => {
    let offset = 0;
    let stalls = 0;
    while (offset < total) {
      const end = Math.min(total, offset + DRIVE_CHUNK_SIZE);
      const res = await fetch(sessionUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Range": `bytes ${offset}-${end - 1}/${total}`,
        },
        // Read from disk per chunk (a 308 may rewind `offset`, so chunks are
        // re-read rather than sliced from one whole-file Buffer).
        body: await readRange(fh, offset, end),
        // 308 here means "Resume Incomplete", not a redirect.
        redirect: "manual",
        signal,
      });
      if (res.status === 200 || res.status === 201) return true;
      if (res.status !== 308) await failResponse(res, "Google Drive resumable upload");
      await res.body?.cancel().catch(() => undefined);
      const next = driveNextOffset(res.headers.get("range"));
      if (next <= offset) {
        if (++stalls >= 3) throw new Error("Google Drive resumable upload made no progress");
      } else {
        stalls = 0;
      }
      offset = next;
    }
    return false;
  });
  if (done) return;
  // Every byte is persisted but the final 200/201 never arrived: ask for status.
  const status = await fetch(sessionUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Range": `bytes */${total}` },
    redirect: "manual",
    signal: controlSignal(signal),
  });
  if (status.status !== 200 && status.status !== 201) await failResponse(status, "Google Drive resumable finalize");
}

async function uploadGoogleDrive(conn: CloudConn, src: UploadSource, fileName: string, mimeType: string, signal: AbortSignal): Promise<void> {
  const token = await getAccessToken(conn, signal);
  const segments = uploadPathSegments(conn.uploadPath);
  const upload = async () => {
    const folderId = await resolveDriveFolder(conn.id, token, segments, signal);
    const meta = { name: fileName, parents: [folderId] };
    if (src.size > DRIVE_RESUMABLE_THRESHOLD) await driveResumableUpload(token, meta, src, mimeType, signal);
    else await driveMultipartUpload(token, meta, await readSmallFile(src), mimeType, signal);
  };
  try {
    await upload();
  } catch (err) {
    // A cached folder the user has since deleted makes Drive 404 the parent:
    // drop the cached id and resolve the path again, once.
    if (err instanceof RemoteHttpError && err.status === 404 && segments.length > 0) {
      driveFolderCache.delete(`${conn.id}:${segments.join("/")}`);
      await upload();
      return;
    }
    throw err;
  }
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

const GRAPH_DRIVE = "https://graph.microsoft.com/v1.0/me/drive";

/**
 * Small files: one PUT to the path-addressed item (parents are created by
 * Graph). Larger ones: an upload session, PUT in ONEDRIVE_CHUNK_SIZE fragments.
 * Every path segment and the file name are percent-encoded, and name clashes
 * are auto-renamed ("photo 1.jpg") rather than overwriting an existing file.
 */
async function uploadOneDrive(conn: CloudConn, src: UploadSource, fileName: string, signal: AbortSignal): Promise<void> {
  const token = await getAccessToken(conn, signal);
  const item = oneDriveItemPath(uploadPathSegments(conn.uploadPath), fileName);

  if (src.size <= ONEDRIVE_SESSION_THRESHOLD) {
    const res = await fetch(`${GRAPH_DRIVE}/${item}/content?@microsoft.graph.conflictBehavior=rename`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: await readSmallFile(src),
      signal,
    });
    if (!res.ok) await failResponse(res, "OneDrive upload");
    return;
  }

  const created = await fetch(`${GRAPH_DRIVE}/${item}/createUploadSession`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
    signal: controlSignal(signal),
  });
  if (!created.ok) await failResponse(created, "OneDrive upload session");
  const { uploadUrl } = await created.json() as { uploadUrl?: string };
  if (!uploadUrl || !uploadUrl.startsWith("https://")) throw new Error("OneDrive did not return an upload URL");

  try {
    const total = src.size;
    await withSourceFile(src, async (fh) => {
      for (const [start, end] of chunkRanges(total, ONEDRIVE_CHUNK_SIZE)) {
        // The upload URL is pre-authenticated; Graph documents that sending the
        // Authorization header to it can cause a 401.
        const res = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Range": `bytes ${start}-${end - 1}/${total}`,
          },
          body: await readRange(fh, start, end),
          signal,
        });
        if (!res.ok) await failResponse(res, "OneDrive upload fragment");
        // 202 = more fragments expected; 200/201 = file committed.
        if (end === total && res.status !== 200 && res.status !== 201) {
          throw new Error(`OneDrive upload did not complete (status ${res.status})`);
        }
        await res.body?.cancel().catch(() => undefined);
      }
    });
  } catch (err) {
    // Free the server-side temp file; best-effort, it also expires on its own.
    await fetch(uploadUrl, { method: "DELETE", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    throw err;
  }
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
async function uploadDropbox(conn: CloudConn, src: UploadSource, fileName: string, signal: AbortSignal): Promise<void> {
  const token = await getAccessToken(conn, signal);
  const commit = { path: dropboxPath(conn.uploadPath, fileName), mode: "add", autorename: true };

  if (src.size <= DROPBOX_SESSION_THRESHOLD) {
    await dropboxContentCall(token, "upload", commit, await readSmallFile(src), signal);
    return;
  }

  // Each chunk is read from disk just before it is sent — one in memory at a time.
  await withSourceFile(src, async (fh) => {
    const ranges = chunkRanges(src.size, DROPBOX_CHUNK_SIZE);
    const [firstStart, firstEnd] = ranges[0]!;
    const started = await dropboxContentCall(token, "upload_session/start", { close: false }, await readRange(fh, firstStart, firstEnd), signal);
    const sessionId = started?.session_id;
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Dropbox did not return an upload session id");

    for (let i = 1; i < ranges.length - 1; i++) {
      const [start, end] = ranges[i]!;
      await dropboxContentCall(token, "upload_session/append_v2", { cursor: { session_id: sessionId, offset: start }, close: false }, await readRange(fh, start, end), signal);
    }

    // Finish carries the last chunk (or nothing, if the file fit in the first).
    const [lastStart, lastEnd] = ranges.length > 1 ? ranges[ranges.length - 1]! : [firstEnd, firstEnd];
    await dropboxContentCall(
      token,
      "upload_session/finish",
      { cursor: { session_id: sessionId, offset: lastStart }, commit },
      await readRange(fh, lastStart, lastEnd),
      signal,
    );
  });
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

// ─── Token revocation ─────────────────────────────────────────────────────────

const REVOKE_TIMEOUT_MS = 10_000;

/**
 * Best-effort: revoke a connection's OAuth grant at the provider when the user
 * disconnects it, so a leaked database row stops being useful. Never throws —
 * the caller has already deleted the row and must not care.
 *
 *  - Google: POST the refresh token (or the access token) to /revoke; revoking
 *    a refresh token also invalidates its access tokens.
 *  - Dropbox: /2/auth/token/revoke disables the calling access token and the
 *    refresh token behind it. An expired access token is refreshed first
 *    (without persisting — the row is gone) so the call can authenticate.
 *  - Microsoft Graph has no token-revocation endpoint for this flow; the
 *    refresh token simply stops being used and expires. Skipped.
 */
export async function revokeProviderTokens(conn: CloudConn): Promise<void> {
  try {
    const access = decryptCredential(conn.accessTokenEncrypted);
    const refresh = conn.refreshToken ? decryptCredential(conn.refreshToken) : "";
    if (conn.type === "googledrive") {
      const token = refresh || access;
      if (!token) return;
      const res = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
      if (!res.ok) logger.info({ connectionId: conn.id, status: res.status }, "Google token revoke not accepted");
      return;
    }
    if (conn.type === "dropbox") {
      let token = access;
      const expired = conn.tokenExpiry != null && conn.tokenExpiry.getTime() < Date.now() + 60_000;
      if ((!token || expired) && refresh) {
        const cfg = OAUTH_CONFIG["dropbox"]!;
        const res = await fetch(cfg.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refresh,
            client_id: process.env[cfg.clientIdEnv] ?? "",
            client_secret: process.env[cfg.clientSecretEnv] ?? "",
          }).toString(),
          signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        });
        if (res.ok) token = ((await res.json()) as { access_token?: string }).access_token ?? token;
      }
      if (!token) return;
      // No-arg RPC: POST with no body and no Content-Type.
      const res = await fetch("https://api.dropboxapi.com/2/auth/token/revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
      if (!res.ok) logger.info({ connectionId: conn.id, status: res.status }, "Dropbox token revoke not accepted");
    }
  } catch (err) {
    logger.info({ err, connectionId: conn.id, type: conn.type }, "Token revoke failed (ignored)");
  }
}

/** Providers with a token-revocation endpoint (see revokeProviderTokens). */
const REVOCABLE_TYPES = new Set(["googledrive", "dropbox"]);

type ConnectionRow = typeof cloudConnectionsTable.$inferSelect;

/**
 * Revoke a removed row's grant unless another row may ride on the same grant.
 * A provider revoke kills the whole grant (Google: every token for this app +
 * account), so it is skipped when the same account is connected elsewhere —
 * the same user's row of this type with the same (or an unknown) account id,
 * or ANY user's row with the same account id (a pending row created by
 * someone else's authorize link must not disconnect the owner's real one).
 * Best-effort; never throws.
 */
export async function revokeRemovedConnectionIfUnshared(conn: ConnectionRow): Promise<void> {
  if (!REVOCABLE_TYPES.has(conn.type) || !(conn.refreshToken || conn.accessTokenEncrypted)) return;
  try {
    const others = await db.select({ userId: cloudConnectionsTable.userId, accountId: cloudConnectionsTable.accountId })
      .from(cloudConnectionsTable)
      .where(and(
        eq(cloudConnectionsTable.type, conn.type),
        ne(cloudConnectionsTable.id, conn.id),
        conn.accountId
          ? or(eq(cloudConnectionsTable.userId, conn.userId), eq(cloudConnectionsTable.accountId, conn.accountId))
          : eq(cloudConnectionsTable.userId, conn.userId),
      ));
    const shared = others.some((c) => c.userId === conn.userId
      ? !c.accountId || !conn.accountId || c.accountId === conn.accountId
      : c.accountId === conn.accountId);
    if (!shared) await revokeProviderTokens(conn);
  } catch (err) {
    logger.info({ err, connectionId: conn.id }, "Token revoke skipped");
  }
}

// ─── Pending OAuth connections ────────────────────────────────────────────────
// The OAuth callback stores tokens on a PENDING row (pendingNonceHash set,
// active=false) that only /oauth/complete — from the device that started the
// flow — can confirm. Unconfirmed rows are deleted once they expire.

const PENDING_PURGE_INTERVAL_MS = 60_000;
let lastPendingPurge = 0;

/**
 * Delete expired pending rows (every user's) and revoke their grants in the
 * background. Called opportunistically from the OAuth / connection routes and
 * throttled per process; never throws.
 */
export async function purgeExpiredPendingConnections(): Promise<void> {
  const now = Date.now();
  if (now - lastPendingPurge < PENDING_PURGE_INTERVAL_MS) return;
  lastPendingPurge = now;
  try {
    const removed = await db.delete(cloudConnectionsTable).where(and(
      isNotNull(cloudConnectionsTable.pendingNonceHash),
      or(isNull(cloudConnectionsTable.pendingExpiresAt), lt(cloudConnectionsTable.pendingExpiresAt, new Date(now))),
    )).returning();
    if (removed.length === 0) return;
    logger.info({ count: removed.length }, "Purged expired pending OAuth connections");
    void Promise.allSettled(removed.map((c) => revokeRemovedConnectionIfUnshared(c)));
  } catch (err) {
    logger.warn({ err }, "Pending OAuth connection purge failed");
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function uploadToCloud(conn: CloudConn, src: UploadSource, rawFileName: string, mimeType: string): Promise<UploadResult> {
  const fileName = sanitizeFileName(rawFileName);
  // One overall deadline per provider upload, scaled with size and capped
  // (see uploadDeadlineMs) so a stalled remote always frees the upload slot.
  const deadlineMs = uploadDeadlineMs(src.size);
  const signal = AbortSignal.timeout(deadlineMs);
  try {
    switch (conn.type) {
      case "ftp":         await uploadFtp(conn, src, fileName, signal); break;
      case "webdav":      await uploadWebdav(conn, src, fileName, signal); break;
      case "nextcloud":   await uploadNextcloud(conn, src, fileName, signal); break;
      case "googledrive": await uploadGoogleDrive(conn, src, fileName, mimeType, signal); break;
      case "onedrive":    await uploadOneDrive(conn, src, fileName, signal); break;
      case "dropbox":     await uploadDropbox(conn, src, fileName, signal); break;
      default: throw new Error(`Unknown connection type: ${conn.type}`);
    }
    return { connectionId: conn.id, success: true };
  } catch (err: any) {
    // Full detail (remote status/body, resolver text, IPs) stays in the log;
    // the client — and the stored upload record — only get a generic message.
    logger.warn({ err, connectionId: conn.id, type: conn.type, deadlineMs, bytes: src.size }, "Cloud upload failed");
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
