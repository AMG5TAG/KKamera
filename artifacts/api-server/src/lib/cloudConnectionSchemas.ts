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
 */

/** Mirrors CLOUD_PROVIDER in ./constants.ts — inlined to keep this module
 *  dependency-free; a drift guard in the test asserts the two stay in step. */
const CLOUD_PROVIDERS = ["ftp", "webdav", "nextcloud", "googledrive", "onedrive", "dropbox"] as const;

const NEXTCLOUD = "nextcloud";

const cloudProviders = CLOUD_PROVIDERS as unknown as [string, ...string[]];

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
  uploadPath: z.string().max(500).nullish(),
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

export const updateConnectionSchema = z.object({
  name: z.string().min(1).max(100).nullish(),
  active: z.boolean().nullish(),
  uploadPath: z.string().max(500).nullish(),
  host: z.string().max(500).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  username: z.string().max(200).nullish(),
  password: z.string().max(500).nullish(),
  oauthCode: z.string().max(2000).nullish(),
}).strict();

export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>;
