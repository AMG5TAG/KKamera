import { logger } from "./logger.js";

export interface AccountIdentity {
  /** Stable per-account id used to dedup reconnections (null if lookup failed). */
  accountId: string | null;
  /** Human-readable label (email or display name) shown in the UI. */
  accountLabel: string | null;
}

const EMPTY: AccountIdentity = { accountId: null, accountLabel: null };

// Best-effort: fetch the signed-in account's identity right after the OAuth token
// exchange so the UI can distinguish e.g. a personal vs a business OneDrive, and
// so reconnecting the SAME account refreshes it rather than creating a duplicate.
// Any failure (missing scope, provider hiccup) degrades to nulls — never blocks
// the connection. Each call is time-boxed so a hung provider can't stall the
// OAuth callback.
export async function fetchAccountIdentity(provider: string, accessToken: string): Promise<AccountIdentity> {
  try {
    const signal = AbortSignal.timeout(5000);
    if (provider === "googledrive") return await googleDrive(accessToken, signal);
    if (provider === "onedrive") return await oneDrive(accessToken, signal);
    if (provider === "dropbox") return await dropbox(accessToken, signal);
  } catch (err) {
    logger.warn({ err, provider }, "Account identity lookup failed — continuing without a label");
  }
  return EMPTY;
}

async function googleDrive(token: string, signal: AbortSignal): Promise<AccountIdentity> {
  const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) return EMPTY;
  const data = (await res.json()) as { user?: { emailAddress?: string; displayName?: string; permissionId?: string } };
  const u = data.user ?? {};
  return {
    accountId: u.permissionId ?? u.emailAddress ?? null,
    accountLabel: u.emailAddress ?? u.displayName ?? null,
  };
}

async function oneDrive(token: string, signal: AbortSignal): Promise<AccountIdentity> {
  // /me/drive works with the Files.ReadWrite scope (no extra User.Read needed);
  // owner.user carries the display name and, on most tenants, the email.
  const res = await fetch("https://graph.microsoft.com/v1.0/me/drive?$select=id,owner", {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) return EMPTY;
  const data = (await res.json()) as { id?: string; owner?: { user?: { displayName?: string; email?: string } } };
  const owner = data.owner?.user ?? {};
  return {
    accountId: data.id ?? owner.email ?? null,
    accountLabel: owner.email ?? owner.displayName ?? null,
  };
}

async function dropbox(token: string, signal: AbortSignal): Promise<AccountIdentity> {
  // get_current_account is a no-arg RPC — it must be POSTed with an empty body
  // and NO Content-Type header, otherwise Dropbox rejects it.
  const res = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) return EMPTY;
  const data = (await res.json()) as { account_id?: string; email?: string; name?: { display_name?: string } };
  return {
    accountId: data.account_id ?? data.email ?? null,
    accountLabel: data.email ?? data.name?.display_name ?? null,
  };
}
