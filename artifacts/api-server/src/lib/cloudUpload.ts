import { Client as FtpClient } from "basic-ftp";
import { createClient as createWebdavClient } from "webdav";
import { Readable } from "stream";
import dns from "dns";
import net from "net";
import { db } from "@workspace/db";
import { cloudConnectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";
import { encrypt, decrypt } from "./crypto.js";

// ─── SSRF guard ───────────────────────────────────────────────────────────────
// User-supplied FTP/WebDAV hosts are attacker-controlled. Without this guard a
// user could point a connection at internal infrastructure (cloud metadata at
// 169.254.169.254, localhost services, RFC-1918 hosts) and use the test/upload
// endpoints as an SSRF pivot. We resolve the host and reject private targets.

function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;             // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16/12
  if (a === 192 && b === 168) return true;             // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT 100.64/10
  if (a >= 224) return true;                           // multicast / reserved
  return false;
}

/** Expand an IPv6 literal (any notation, incl. embedded IPv4) to its 16 bytes, or null. */
function ipv6ToBytes(ip: string): number[] | null {
  let s = ip.split("%")[0]!; // drop zone id
  // Convert a trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) into two hextets.
  const v4 = s.match(/(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = [v4[2], v4[3], v4[4], v4[5]].map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${v4[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const groups = tail === null
    ? head
    : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

/** True if an IP literal falls in a private / loopback / link-local / reserved range. */
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return isPrivateIpv4(a, b);
  }
  if (net.isIPv6(ip)) {
    const x = ipv6ToBytes(ip);
    if (!x) return true; // unparseable → treat as unsafe
    if (x.every((n) => n === 0)) return true;                                  // ::
    if (x.slice(0, 15).every((n) => n === 0) && x[15] === 1) return true;      // ::1
    if (x[0] === 0xfe && (x[1]! & 0xc0) === 0x80) return true;                 // fe80::/10 link-local
    if ((x[0]! & 0xfe) === 0xfc) return true;                                  // fc00::/7 ULA
    // Block any IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), or NAT64
    // (64:ff9b::/96) address — these can target internal v4 via an IPv6 literal
    // and are never needed for a legitimate public cloud host.
    if (x.slice(0, 10).every((n) => n === 0) && x[10] === 0xff && x[11] === 0xff) return true;
    if (x.slice(0, 12).every((n) => n === 0)) return true;
    if (x[0] === 0x00 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b) return true;
    return false;
  }
  return true; // not a valid IP → unsafe
}

/**
 * Throw unless `rawHost` (a bare hostname or a full URL) resolves only to public
 * addresses. NOTE: this is a best-effort guard — a determined attacker could still
 * use DNS rebinding (resolve public here, private at connect time). Pinning the
 * resolved IP through to the FTP/WebDAV client would close that; tracked separately.
 */
async function assertPublicHost(rawHost: string): Promise<void> {
  let hostname = rawHost.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(hostname)) {
    try { hostname = new URL(hostname).hostname; } catch { /* treat as bare host */ }
  }
  hostname = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!hostname) throw new Error("Invalid host");

  const lowered = hostname.toLowerCase();
  if (
    lowered === "localhost" ||
    lowered.endsWith(".localhost") ||
    lowered.endsWith(".local") ||
    lowered.endsWith(".internal")
  ) {
    throw new Error("Host not allowed");
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("Host points to a private address and is not allowed");
    return;
  }

  const addrs = await dns.promises.lookup(hostname, { all: true });
  if (addrs.length === 0) throw new Error("Host did not resolve");
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error("Host resolves to a private address and is not allowed");
  }
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
 * Strip any path components from a client-supplied filename so it cannot
 * traverse out of the configured upload directory (e.g. "../../etc/x").
 * Returns just the final path segment with separators removed.
 */
function sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/^\.+/, "").trim();
  return cleaned || `upload_${Date.now()}`;
}

// ─── OAuth Auto-Refresh ───────────────────────────────────────────────────────

const OAUTH_CONFIG: Record<string, { tokenUrl: string; clientIdEnv: string; clientSecretEnv: string }> = {
  googledrive: {
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
  },
  onedrive: {
    tokenUrl: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
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
async function refreshAndPersistToken(conn: CloudConn): Promise<string> {
  const cfg = OAUTH_CONFIG[conn.type];
  if (!cfg) throw new Error(`No refresh config for provider: ${conn.type}`);
  if (!conn.refreshToken) throw new Error(`No refresh token stored for connection ${conn.id} — re-connect the account.`);

  const refreshTok = decrypt(conn.refreshToken);
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
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
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
async function getAccessToken(conn: CloudConn): Promise<string> {
  const raw = conn.accessTokenEncrypted ? decrypt(conn.accessTokenEncrypted) : "";
  const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000);
  const expiringSoon = conn.tokenExpiry != null && conn.tokenExpiry < fiveMinFromNow;

  if ((!raw || expiringSoon) && conn.refreshToken) {
    return refreshAndPersistToken(conn);
  }

  if (!raw) {
    throw new Error(`No access token for ${conn.type} connection (id=${conn.id}). Please re-connect the account.`);
  }
  return raw;
}

// ─── FTP ──────────────────────────────────────────────────────────────────────

/**
 * Connect an FTP client, preferring an encrypted FTPS (AUTH TLS) session and
 * only falling back to plaintext when the server doesn't support TLS. Caller
 * must have already validated `conn.host` via assertPublicHost.
 */
async function ftpConnect(client: FtpClient, conn: CloudConn): Promise<void> {
  const base = {
    host: conn.host!,
    port: conn.port ?? 21,
    user: conn.username ?? "anonymous",
    password: conn.passwordEncrypted ? decrypt(conn.passwordEncrypted) : "",
  };
  try {
    // Explicit FTPS. Many self-hosted FTP servers use self-signed certs, so we
    // don't hard-fail on cert validation — encrypted-but-unpinned still beats
    // sending credentials and photos in cleartext.
    await client.access({ ...base, secure: true, secureOptions: { rejectUnauthorized: false } });
  } catch {
    await client.access({ ...base, secure: false });
    logger.warn({ connectionId: conn.id }, "FTP server does not support TLS — connection is unencrypted");
  }
}

async function uploadFtp(conn: CloudConn, buf: Buffer, fileName: string): Promise<void> {
  await assertPublicHost(conn.host!);
  const client = new FtpClient(20_000);
  try {
    await ftpConnect(client, conn);
    const dir = conn.uploadPath ?? "/KKamera";
    await client.ensureDir(dir);
    await client.uploadFrom(Readable.from(buf), `${dir}/${fileName}`);
  } finally {
    client.close();
  }
}

async function testFtp(conn: CloudConn): Promise<{ success: boolean; message: string }> {
  const client = new FtpClient(10_000);
  try {
    await assertPublicHost(conn.host!);
    await ftpConnect(client, conn);
    await client.list("/");
    return { success: true, message: "FTP connection successful" };
  } catch (err: any) {
    return { success: false, message: err.message };
  } finally {
    client.close();
  }
}

// ─── WebDAV ───────────────────────────────────────────────────────────────────

async function uploadWebdav(conn: CloudConn, buf: Buffer, fileName: string): Promise<void> {
  await assertPublicHost(conn.host!);
  const pass = conn.passwordEncrypted ? decrypt(conn.passwordEncrypted) : "";
  const client = createWebdavClient(conn.host!, {
    username: conn.username ?? undefined,
    password: pass || undefined,
  });
  const dir = conn.uploadPath ?? "/KKamera";
  if (!(await client.exists(dir))) {
    await client.createDirectory(dir, { recursive: true });
  }
  await client.putFileContents(`${dir}/${fileName}`, buf, { overwrite: true });
}

async function testWebdav(conn: CloudConn): Promise<{ success: boolean; message: string }> {
  try {
    await assertPublicHost(conn.host!);
    const pass = conn.passwordEncrypted ? decrypt(conn.passwordEncrypted) : "";
    const client = createWebdavClient(conn.host!, {
      username: conn.username ?? undefined,
      password: pass || undefined,
    });
    const exists = await client.exists(conn.uploadPath ?? "/");
    return {
      success: true,
      message: exists
        ? "WebDAV folder exists and is accessible"
        : "WebDAV connected — upload folder will be created on first upload",
    };
  } catch (err: any) {
    return { success: false, message: err.message };
  }
}

// ─── Google Drive ─────────────────────────────────────────────────────────────

async function ensureDriveFolder(token: string, folderName: string): Promise<string> {
  // Escape single quotes and backslashes per Google Drive query syntax so the
  // folder name can't break out of the quoted string in the `q` parameter.
  const escaped = folderName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const search = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await search.json() as any;
  if (data.files?.length > 0) return data.files[0].id as string;
  const create = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder" }),
  });
  const folder = await create.json() as any;
  if (!folder.id) throw new Error(`Could not create Drive folder: ${JSON.stringify(folder)}`);
  return folder.id as string;
}

async function uploadGoogleDrive(conn: CloudConn, buf: Buffer, fileName: string, mimeType: string): Promise<void> {
  const token = await getAccessToken(conn);
  const folderName = (conn.uploadPath ?? "/KKamera").replace(/^\/+/, "") || "KKamera";
  const folderId = await ensureDriveFolder(token, folderName);
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
  });
  if (!res.ok) throw new Error(`Google Drive upload failed: ${res.status} ${await res.text()}`);
}

async function testGoogleDrive(conn: CloudConn): Promise<{ success: boolean; message: string }> {
  try {
    const token = await getAccessToken(conn);
    const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { success: false, message: `Token invalid (${res.status}) — re-connect your Google account.` };
    const data = await res.json() as any;
    return { success: true, message: `Connected as ${data.user?.displayName ?? "Google user"}` };
  } catch (err: any) {
    return { success: false, message: err.message };
  }
}

// ─── OneDrive ─────────────────────────────────────────────────────────────────

async function uploadOneDrive(conn: CloudConn, buf: Buffer, fileName: string): Promise<void> {
  const token = await getAccessToken(conn);
  const dir = (conn.uploadPath ?? "/KKamera").replace(/^\/+/, "");
  const url = `https://graph.microsoft.com/v1.0/me/drive/root:/${dir}/${fileName}:/content`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body: buf,
  });
  if (!res.ok) throw new Error(`OneDrive upload failed: ${res.status} ${await res.text()}`);
}

async function testOneDrive(conn: CloudConn): Promise<{ success: boolean; message: string }> {
  try {
    const token = await getAccessToken(conn);
    // /me requires User.Read; the token only carries Files.ReadWrite, so probe the drive instead
    const res = await fetch("https://graph.microsoft.com/v1.0/me/drive", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { success: false, message: `Token invalid (${res.status}) — re-connect your Microsoft account.` };
    const data = await res.json() as any;
    return { success: true, message: `Connected as ${data.owner?.user?.displayName ?? "Microsoft user"}` };
  } catch (err: any) {
    return { success: false, message: err.message };
  }
}

// ─── Dropbox ──────────────────────────────────────────────────────────────────

async function uploadDropbox(conn: CloudConn, buf: Buffer, fileName: string): Promise<void> {
  const token = await getAccessToken(conn);
  const path = `${conn.uploadPath ?? "/KKamera"}/${fileName}`;
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path, mode: "add", autorename: true }),
    },
    body: buf,
  });
  if (!res.ok) throw new Error(`Dropbox upload failed: ${res.status} ${await res.text()}`);
}

async function testDropbox(conn: CloudConn): Promise<{ success: boolean; message: string }> {
  try {
    const token = await getAccessToken(conn);
    const res = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { success: false, message: `Token invalid (${res.status}) — re-connect your Dropbox account.` };
    const data = await res.json() as any;
    return { success: true, message: `Connected as ${data.name?.display_name ?? "Dropbox user"}` };
  } catch (err: any) {
    return { success: false, message: err.message };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function uploadToCloud(conn: CloudConn, buf: Buffer, rawFileName: string, mimeType: string): Promise<UploadResult> {
  const fileName = sanitizeFileName(rawFileName);
  try {
    switch (conn.type) {
      case "ftp":         await uploadFtp(conn, buf, fileName); break;
      case "webdav":      await uploadWebdav(conn, buf, fileName); break;
      case "googledrive": await uploadGoogleDrive(conn, buf, fileName, mimeType); break;
      case "onedrive":    await uploadOneDrive(conn, buf, fileName); break;
      case "dropbox":     await uploadDropbox(conn, buf, fileName); break;
      default: throw new Error(`Unknown connection type: ${conn.type}`);
    }
    return { connectionId: conn.id, success: true };
  } catch (err: any) {
    logger.warn({ err, connectionId: conn.id, type: conn.type }, "Cloud upload failed");
    return { connectionId: conn.id, success: false, error: String(err?.message ?? err) };
  }
}

export async function testCloudConnection(conn: CloudConn): Promise<{ success: boolean; message: string }> {
  if (!conn.host && !conn.accessTokenEncrypted && conn.type !== "ftp" && conn.type !== "webdav") {
    return { success: false, message: "No credentials configured for this connection." };
  }
  switch (conn.type) {
    case "ftp":         return testFtp(conn);
    case "webdav":      return testWebdav(conn);
    case "googledrive": return testGoogleDrive(conn);
    case "onedrive":    return testOneDrive(conn);
    case "dropbox":     return testDropbox(conn);
    default: return { success: false, message: `Unknown type: ${conn.type}` };
  }
}
