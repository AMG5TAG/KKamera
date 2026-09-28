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
 * app sends null for "not applicable" (e.g. `oauthCode` on a manual FTP/WebDAV
 * connection). `.optional()` accepts only `undefined`, so these MUST be
 * `.nullish()` or the server rejects bodies its own spec says are valid.
 * (Updates are different: there null means "clear" — see updateConnectionSchema.)
 */

/** Mirrors CLOUD_PROVIDER in ./constants.ts — inlined to keep this module
 *  dependency-free; a drift guard in the test asserts the two stay in step. */
const CLOUD_PROVIDERS = ["ftp", "webdav", "nextcloud", "googledrive", "onedrive", "dropbox"] as const;

const NEXTCLOUD = "nextcloud";

const cloudProviders = CLOUD_PROVIDERS as unknown as [string, ...string[]];

/**
 * Upload path shape check. ".." segments are rejected outright (separators may
 * be "/" or "\\"): no provider needs them, and on FTP/WebDAV they would walk
 * out of the folder the user thinks they picked. Mirrors `hasParentSegment` in
 * ./cloudUploadPolicy.ts (inlined — see the note above); the test asserts the
 * two agree.
 */
const uploadPathField = z.string().max(500).refine(
  (p) => !p.split(/[\\/]+/).some((seg) => seg.trim() === ".."),
  { message: 'must not contain ".." segments' },
).refine(
  (p) => !/[\u0000-\u001f\u007f]/.test(p),
  { message: "must not contain control characters" },
);

export const createConnectionSchema = z.object({
  type: z.enum(cloudProviders),
  provider: z.string().max(50).nullish(),
  name: z.string().min(1).max(100),
  // A bare hostname or a full URL — validated per-protocol at connect time
  // (and always against the SSRF guard), so only shape is checked here.
  host: z.string().min(1).max(500).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  username: z.string().max(200).nullish(),
  password: z.string().max(500).nullish(),
  uploadPath: uploadPathField.nullish(),
  oauthCode: z.string().max(2000).nullish(),
}).superRefine((val, ctx) => {
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
 * upload). `oauthCode` is replace-only. Type-specific requirements (Nextcloud
 * needs a username) are checked against the stored row by the route.
 */
export const updateConnectionSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  active: z.boolean().optional(),
  uploadPath: uploadPathField.nullable().optional(),
  host: z.string().trim().min(1, "must not be empty").max(500).optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  username: z.string().max(200).nullable().optional(),
  password: z.string().max(500).nullable().optional(),
  oauthCode: z.string().min(1).max(2000).optional(),
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
  oauthCode?: string;
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
  if (input.oauthCode !== undefined) plan.oauthCode = input.oauthCode;
  return plan;
}
