import { Client as FtpClient } from "basic-ftp";
import { createClient as createWebdavClient } from "webdav";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { Readable } from "stream";
import { db } from "@workspace/db";
import { cloudConnectionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

const ENC_KEY = (process.env["SESSION_SECRET"] || "dev-secret-kkamera-32-chars-paddd").slice(0, 32);

function decrypt(enc: string): string {
  const [ivHex, dataHex] = enc.split(":");
  if (!ivHex || !dataHex) return "";
  const decipher = createDecipheriv("aes-256-cbc", Buffer.from(ENC_KEY), Buffer.from(ivHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString();
}

function encrypt(text: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", Buffer.from(ENC_KEY), iv);
  return iv.toString("hex") + ":" + Buffer.concat([cipher.update(text), cipher.final()]).toString("hex");
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

async function uploadFtp(conn: CloudConn, buf: Buffer, fileName: string): Promise<void> {
  const client = new FtpClient(20_000);
  try {
    await client.access({
      host: conn.host!,
      port: conn.port ?? 21,
      user: conn.username ?? "anonymous",
      password: conn.passwordEncrypted ? decrypt(conn.passwordEncrypted) : "",
      secure: false,
    });
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
    await client.access({
      host: conn.host!,
      port: conn.port ?? 21,
      user: conn.username ?? "anonymous",
      password: conn.passwordEncrypted ? decrypt(conn.passwordEncrypted) : "",
      secure: false,
    });
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
  const q = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
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
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { success: false, message: `Token invalid (${res.status}) — re-connect your Microsoft account.` };
    const data = await res.json() as any;
    return { success: true, message: `Connected as ${data.displayName ?? "Microsoft user"}` };
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

export async function uploadToCloud(conn: CloudConn, buf: Buffer, fileName: string, mimeType: string): Promise<UploadResult> {
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
