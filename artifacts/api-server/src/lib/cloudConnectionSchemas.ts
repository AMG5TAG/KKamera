import { z } from "zod";

/**
 * Request schemas for the cloud-connection routes.
 *
 * Kept pure (zod only, no express/db/local imports) so the null-handling below
 * can be unit-tested — it is easy to get wrong and fails in a way the UI used
 * to swallow.
 *
 * NOTE ON NULLS: `CloudConnectionInput`/`CloudConnectionUpdate` in
 * `lib/api-spec/openapi.yaml` declare every optional field as
 * `type: ["string", "null"]`, so the generated client types allow null and the
 * app sends null for "not applicable" (e.g. `provider` on a plain FTP/WebDAV
 * connection). `.optional()` accepts only `undefined`, so these MUST be
 * `.nullish()` or the server rejects bodies its own spec says are valid.
 * (Updates are different: there null means "clear" — see updateConnectionSchema.)
 */

/** Mirrors CLOUD_PROVIDER in ./constants.ts — inlined to keep this module
 *  dependency-free; a drift guard in the test asserts the two stay in step. */
const CLOUD_PROVIDERS = ["ftp", "webdav", "nextcloud", "googledrive", "onedrive", "dropbox"] as const;

const NEXTCLOUD = "nextcloud";

/**
 * Providers connected through the OAuth callback + POST /oauth/complete (see
 * routes/oauth.ts). The manual create route must never mint one: it would
 * bypass the device-bound pending-connection flow.
 */
export const OAUTH_ONLY_PROVIDERS: ReadonlySet<string> = new Set(["googledrive", "onedrive", "dropbox"]);

const cloudProviders = CLOUD_PROVIDERS as unknown as [string, ...string[]];

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const noControlChars = { message: "must not contain control characters" };

/**
 * Upload path shape check. ".." segments are rejected outright (separators may
 * be "/" or "\\"): no provider needs them, and on FTP/WebDAV they would walk
 * out of the folder the user thinks they picked. Mirrors `hasParentSegment` in
 * ./cloudUploadPolicy.ts (inlined — see the note above); the test asserts the
 * two agree.
 */
const uploadPathField = z.string().trim().max(500).refine(
  (p) => !p.split(/[\\/]+/).some((seg) => seg.trim() === ".."),
  { message: 'must not contain ".." segments' },
).refine((p) => !CONTROL_CHARS.test(p), noControlChars);

/** Display name: trimmed, 1–100 chars, single line. */
const nameField = z.string().trim().min(1, "must not be empty").max(100).refine((v) => !CONTROL_CHARS.test(v), noControlChars);

/** Login name: trimmed, ≤200 chars, single line (blank is stored as null). */
const usernameField = z.string().trim().max(200).refine((v) => !CONTROL_CHARS.test(v), noControlChars);

/**
 * True when a host / server URL carries userinfo ("user:pw@host" or
 * "https://user@host/…"). Such a host would be stored and echoed back with the
 * secret in it, and the app opens the host in a browser — credentials belong
 * in the username/password fields, where the password is encrypted and never
 * returned.
 */
export function hostHasUserinfo(host: string): boolean {
  const withoutScheme = host.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const authority = withoutScheme.split(/[/?#\\]/, 1)[0] ?? "";
  return authority.includes("@");
}

const USERINFO_MESSAGE = "Put the username and password in their own fields";

/** Server URL / hostname: trimmed, non-blank, ≤500 chars, no control chars, no userinfo. */
const hostField = z.string().trim().min(1, "must not be empty").max(500)
  .refine((v) => !CONTROL_CHARS.test(v), noControlChars)
  .refine((v) => !hostHasUserinfo(v), { message: USERINFO_MESSAGE });

export const createConnectionSchema = z.object({
  type: z.enum(cloudProviders),
  provider: z.string().max(50).nullish(),
  name: nameField,
  // A bare hostname or a full URL — validated per-protocol at connect time
  // (and always against the SSRF guard), so only shape is checked here.
  host: hostField.nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  username: usernameField.nullish(),
  password: z.string().max(500).nullish(),
  uploadPath: uploadPathField.nullish(),
  // Legacy field: older app builds send an explicit null. A token is never
  // accepted here — OAuth connections come only from the OAuth flow.
  oauthCode: z.unknown().optional(),
}).superRefine((val, ctx) => {
  if (OAUTH_ONLY_PROVIDERS.has(val.type)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["type"],
      message: "This provider is connected by signing in to it from the app, not by creating a connection manually",
    });
    return;
  }
  if (val.oauthCode !== undefined && val.oauthCode !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["oauthCode"], message: "is no longer accepted" });
    return;
  }
  // Nextcloud's WebDAV endpoint is built from the server URL *and* the login
  // (…/remote.php/dav/files/<username>), so a connection missing either can
  // never upload — reject it here rather than at capture time.
  if (val.type !== NEXTCLOUD) return;
  if (!val.host?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["host"], message: "Nextcloud server URL is required" });
  }
  if (!val.username?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["username"], message: "Nextcloud username is required" });
  }
});

/**
 * PATCH semantics — a field that is ABSENT is left unchanged; an explicit
 * `null` CLEARS it:
 *
 *  - password → removes the saved password (anonymous / passwordless login)
 *  - port     → back to the protocol default
 *  - username → removes the saved login
 *  - uploadPath → back to the default folder ("/KKamera")
 *
 * `name`, `active` and `host` cannot be cleared: they are non-null strings /
 * booleans, and `host` must be non-blank (a connection without one can never
 * upload). Type-specific requirements (Nextcloud
 * needs a username) are checked against the stored row by the route.
 */
export const updateConnectionSchema = z.object({
  name: nameField.optional(),
  active: z.boolean().optional(),
  uploadPath: uploadPathField.nullable().optional(),
  host: hostField.optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  username: usernameField.nullable().optional(),
  password: z.string().max(500).nullable().optional(),
}).strict();

export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>;

/** Column changes for a parsed PATCH body; `undefined` = leave unchanged. */
export interface ConnectionUpdatePlan {
  name?: string;
  active?: boolean;
  uploadPath?: string | null;
  host?: string;
  port?: number | null;
  username?: string | null;
  /** New plaintext password to encrypt, or null to clear the saved one. */
  password?: string | null;
}

/**
 * Turn a parsed PATCH body into column changes, keeping "absent" (unchanged)
 * distinct from `null` (clear). A blank username is stored as null, like on
 * create; an empty-string password is treated as "clear" too.
 */
export function connectionUpdatePlan(input: UpdateConnectionInput): ConnectionUpdatePlan {
  const plan: ConnectionUpdatePlan = {};
  if (input.name !== undefined) plan.name = input.name;
  if (input.active !== undefined) plan.active = input.active;
  if (input.uploadPath !== undefined) plan.uploadPath = input.uploadPath;
  if (input.host !== undefined) plan.host = input.host;
  if (input.port !== undefined) plan.port = input.port;
  if (input.username !== undefined) plan.username = input.username?.trim() ? input.username : null;
  if (input.password !== undefined) plan.password = input.password ? input.password : null;
  return plan;
}
