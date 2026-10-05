/**
 * Pure policy helpers for cloud uploads — deadlines, request validation, FTPS
 * fallback classification, Dropbox header encoding and client-facing error
 * text. Dependency-free (no db/express/local imports) so it is unit-tested
 * directly in test/cloudUploadPolicy.test.ts; the transport lives in
 * cloudUpload.ts.
 */

// ─── Deadlines ────────────────────────────────────────────────────────────────

/** Per-request timeout for small control calls (token refresh, folder lookups, probes). */
export const CONTROL_REQUEST_TIMEOUT_MS = 30_000;
/** Hard cap on one upload to one provider, however large the file. */
export const MAX_UPLOAD_DEADLINE_MS = 15 * 60_000;
const BASE_UPLOAD_DEADLINE_MS = 60_000;
/** Slowest sustained throughput we still wait for (≈ 2 Mbit/s). */
const MIN_THROUGHPUT_BYTES_PER_SEC = 250 * 1024;

/**
 * Overall deadline for uploading `bytes` to one provider: a fixed allowance for
 * connect/auth/folder setup plus time at a slow-but-alive throughput, capped so
 * a stalled remote can never pin a server upload slot indefinitely.
 */
export function uploadDeadlineMs(bytes: number): number {
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return Math.min(MAX_UPLOAD_DEADLINE_MS, BASE_UPLOAD_DEADLINE_MS + Math.ceil((size / MIN_THROUGHPUT_BYTES_PER_SEC) * 1000));
}

// ─── /uploads/execute request validation ─────────────────────────────────────

export const MAX_UPLOAD_FILENAME_LENGTH = 255;

export type ConnectionIdsField =
  | { ok: true; ids: number[] | null } // null = field absent → all active connections
  | { ok: false };

/**
 * Parse the multipart `connectionIds` field. Absent → all active connections.
 * Present → must be a non-empty JSON array of positive integers; anything else
 * is rejected (silently falling back to "all connections" would upload the
 * capture somewhere the user explicitly excluded).
 */
export function parseConnectionIdsField(raw: unknown): ConnectionIdsField {
  if (raw === undefined) return { ok: true, ids: null };
  if (typeof raw !== "string") return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 100) return { ok: false };
  if (!parsed.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0)) return { ok: false };
  return { ok: true, ids: [...new Set(parsed as number[])] };
}

const MIME_RE = /^(image|video)\/[a-z0-9][a-z0-9.+-]{0,99}$/i;

/** Only image/* and video/* types with a plain token subtype (no params, no CR/LF). */
export function isAllowedMimeType(mime: unknown): mime is string {
  return typeof mime === "string" && MIME_RE.test(mime);
}

// ─── Upload paths ─────────────────────────────────────────────────────────────
// One normaliser for every provider. Users type paths like "Photos/KKamera",
// "/Photos/KKamera/", "\\Photos\\KKamera" (Windows habit) or "//a//b"; each
// provider needs the same list of folder names out of that.

/** Folder used when a connection has no upload path stored. */
export const DEFAULT_UPLOAD_PATH = "/KKamera";

/** True when any segment of `raw` is ".." (rejected at create/update time). */
export function hasParentSegment(raw: string): boolean {
  return raw.split(/[\\/]+/).some((seg) => seg.trim() === "..");
}

/**
 * Split an upload path into folder names: backslashes count as separators,
 * empty / "." segments are dropped, each segment is trimmed, and ".." segments
 * are dropped too — validation rejects them, this is the defence in depth for
 * rows stored before it did. `null`/`undefined` means the default folder; an
 * explicit "" or "/" means the account root (no segments).
 */
export function uploadPathSegments(raw: string | null | undefined): string[] {
  const path = raw ?? DEFAULT_UPLOAD_PATH;
  return path
    .split(/[\\/]+/)
    .map((seg) => seg.trim())
    .filter((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Canonical form of an upload path, as stored: separators unified to "/",
 * empty/"."/".." segments dropped, no trailing slash. A leading slash is kept
 * only when the user typed one — every cloud provider treats the path as
 * rooted either way, but FTP distinguishes absolute ("/dir") from relative to
 * the login's home directory ("dir"). "/" is the root, "" the FTP home (and
 * the root elsewhere).
 */
export function normalizeUploadPath(raw: string | null | undefined): string {
  const path = (raw ?? DEFAULT_UPLOAD_PATH).trim();
  const rel = uploadPathSegments(path).join("/");
  return /^[\\/]/.test(path) ? `/${rel}` : rel;
}

/** "/seg/seg/fileName" — the absolute remote path for a file under `segments`. */
export function joinRemotePath(segments: readonly string[], fileName: string): string {
  return "/" + [...segments, fileName].join("/");
}

// ─── Google Drive ─────────────────────────────────────────────────────────────

/** Above this, Drive uploads go resumable (multipart is documented up to 5 MB). */
export const DRIVE_RESUMABLE_THRESHOLD = 5 * 1024 * 1024;
/** Resumable chunk size — Drive requires multiples of 256 KiB (except the last). */
export const DRIVE_CHUNK_SIZE = 16 * 1024 * 1024;

/** Quote a value for a Drive `q=` string literal (backslash and ' escaped). */
export function driveQueryString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Drive `q` for the (non-trashed) folders named `name` directly under `parentId`. */
export function driveFolderQuery(name: string, parentId: string): string {
  return `name=${driveQueryString(name)} and ${driveQueryString(parentId)} in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
}

/**
 * Parse the `Range` header of a Drive 308 "Resume Incomplete" ("bytes=0-N")
 * into the next byte offset to send; no header means nothing was persisted.
 */
export function driveNextOffset(rangeHeader: string | null): number {
  const m = rangeHeader?.match(/^bytes=0-(\d+)$/);
  return m ? Number(m[1]) + 1 : 0;
}

// ─── OneDrive ─────────────────────────────────────────────────────────────────

/** Above this, OneDrive uploads use an upload session instead of one PUT. */
export const ONEDRIVE_SESSION_THRESHOLD = 4 * 1024 * 1024;
/** Session fragment size — must be a multiple of 320 KiB and under 60 MiB. */
export const ONEDRIVE_CHUNK_SIZE = 32 * 320 * 1024; // 10 MiB

/**
 * Graph path-addressing segment ("root:/a/b/file.jpg:") with every folder name
 * and the file name percent-encoded, so '#', '?', '%', spaces and non-ASCII
 * names address the item instead of truncating or corrupting the URL.
 */
export function oneDriveItemPath(segments: readonly string[], fileName: string): string {
  return "root:/" + [...segments, fileName].map(encodeURIComponent).join("/") + ":";
}

// ─── FTPS fallback classification ─────────────────────────────────────────────

const TLS_CERT_ERROR_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
]);

/**
 * True only for a TLS *certificate verification* failure — the one case where
 * retrying with an unverified (still encrypted) session makes sense. Auth,
 * network and protocol errors must not trigger a retry: each retry is another
 * login attempt, and three per upload trips fail2ban on self-hosted servers.
 */
export function isTlsCertError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && TLS_CERT_ERROR_CODES.has(code);
}

/**
 * True when the server refused `AUTH TLS` (no FTPS support): a numeric FTP
 * reply in the 4xx/5xx range other than 530 ("not logged in" — a credential
 * failure, which must never be retried in plaintext).
 */
export function isTlsUnsupportedError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "number") return false;
  return [431, 500, 501, 502, 504, 534].includes(code);
}

// ─── Dropbox ──────────────────────────────────────────────────────────────────

/** Files above this use an upload session (Dropbox's single-call limit is 150 MB). */
export const DROPBOX_SESSION_THRESHOLD = 8 * 1024 * 1024;
/** Session chunk size — a multiple of 4 MB, within Dropbox's 150 MB per-call cap. */
export const DROPBOX_CHUNK_SIZE = 32 * 1024 * 1024;

/**
 * Serialise a `Dropbox-API-Arg` header. HTTP header values must be ASCII, so
 * every non-ASCII character (and DEL) is written as a JSON \uXXXX escape, as
 * Dropbox documents — a raw "Café.jpg" otherwise makes fetch throw or the API
 * reject the request.
 */
export function dropboxApiArg(arg: unknown): string {
  return JSON.stringify(arg).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Absolute Dropbox path for `fileName` under `uploadPath` (always starts with "/"). */
export function dropboxPath(uploadPath: string | null | undefined, fileName: string): string {
  return joinRemotePath(uploadPathSegments(uploadPath), fileName);
}

/** Split `size` bytes into [start, end) ranges of at most `chunk` bytes. */
export function chunkRanges(size: number, chunk: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let start = 0; start < size; start += chunk) out.push([start, Math.min(size, start + chunk)]);
  return out;
}

// ─── Client-facing error text ─────────────────────────────────────────────────

const PROVIDER_LABELS: Record<string, string> = {
  ftp: "FTP server",
  webdav: "WebDAV server",
  nextcloud: "Nextcloud",
  googledrive: "Google Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
};

/** Raised by provider code with the HTTP status of a failed remote call. */
export class RemoteHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RemoteHttpError";
    this.status = status;
  }
}

/**
 * Map a raw upload failure to a generic, per-provider message. Raw errors carry
 * resolver output, internal IPs, remote status bodies and hostnames; those go to
 * the server log only (the caller logs `err`), never back to the client.
 */
export function publicUploadError(type: string, err: unknown): string {
  const label = PROVIDER_LABELS[type] ?? "cloud storage";
  const e = err as { name?: unknown; code?: unknown; status?: unknown; message?: unknown } | null;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const code = e?.code;
  const oauth = type === "googledrive" || type === "onedrive" || type === "dropbox";

  if (e?.name === "TimeoutError" || e?.name === "AbortError" || code === "UPLOAD_DEADLINE") {
    return `Upload to ${label} timed out. It will be retried.`;
  }
  if (status === 401 || status === 403 || code === 530 || code === "REAUTH") {
    return oauth
      ? `${label} rejected the saved sign-in. Re-connect the account in Settings.`
      : `${label} rejected the username or password.`;
  }
  if (status === 507 || (type === "dropbox" && status === 409 && /insufficient_space/.test(String(e?.message)))) {
    return `${label} is out of storage space.`;
  }
  if (status === 429) return `${label} is rate-limiting uploads. It will be retried.`;
  if (code === "ERR_SSRF_BLOCKED" || code === "HOST_NOT_ALLOWED") {
    return `${label} address is not allowed (private or local network addresses can't be used).`;
  }
  return `Upload to ${label} failed.`;
}
