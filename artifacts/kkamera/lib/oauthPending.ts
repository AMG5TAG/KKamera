// Device binding for cloud OAuth (Google Drive / OneDrive / Dropbox).
//
// /oauth/{provider}/initiate returns a one-time `nonce` that must stay on this
// device; the server's callback only creates a PENDING connection and sends the
// browser back with a one-time `code`. The connection is added only once this
// device presents both to /oauth/complete — so an authorize link started on
// someone else's account can't attach this user's cloud storage to it.
//
// The nonce lives in memory (same JS runtime as the auth browser flow), plus
// sessionStorage on web (the page navigates away to the provider and back) or
// AsyncStorage on native (in case the app is restarted while the browser is
// open). It is removed once completion finishes, succeeded or not.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { completeOAuth, getUserFacingMessage } from "@workspace/api-client-react";

const storageKey = (provider: string) => `kkamera.oauthNonce.${provider}`;
const memory = new Map<string, string>();

function webSession(): Storage | null {
  try {
    return Platform.OS === "web" && typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** Keep the nonce from /initiate until the flow returns (keyed by provider). */
export async function rememberOAuthNonce(provider: string, nonce: string): Promise<void> {
  memory.set(provider, nonce);
  try {
    if (Platform.OS === "web") webSession()?.setItem(storageKey(provider), nonce);
    else await AsyncStorage.setItem(storageKey(provider), nonce);
  } catch { /* memory copy still covers the common in-session case */ }
}

async function readOAuthNonce(provider: string): Promise<string | null> {
  const inMemory = memory.get(provider);
  if (inMemory) return inMemory;
  try {
    if (Platform.OS === "web") return webSession()?.getItem(storageKey(provider)) ?? null;
    return await AsyncStorage.getItem(storageKey(provider));
  } catch {
    return null;
  }
}

/** Drop the stored nonce (flow finished, failed or was cancelled). */
export async function forgetOAuthNonce(provider: string): Promise<void> {
  memory.delete(provider);
  try {
    if (Platform.OS === "web") webSession()?.removeItem(storageKey(provider));
    else await AsyncStorage.removeItem(storageKey(provider));
  } catch { /* best-effort */ }
}

/**
 * Drop the stored nonce only when the deep link proves it belongs to this flow
 * (carries the same nonce). oauth-error links can be crafted by anyone, so an
 * unproven one must not cancel a sign-in the user is still completing. (The
 * server's error redirect doesn't carry the nonce today, so in practice the
 * add-cloud screen — which owns the flow — forgets it on failure, and the next
 * /initiate overwrites any leftover.)
 */
export async function forgetOAuthNonceIfMatches(provider: string, nonce: string | null | undefined): Promise<boolean> {
  if (!nonce) return false;
  const stored = await readOAuthNonce(provider);
  if (!stored || stored !== nonce) return false;
  await forgetOAuthNonce(provider);
  return true;
}

// Fixed, user-facing messages for the error values the OAuth callback (and the
// providers it forwards) send back. The deep-link `error` param is attacker-
// controllable, so it is only ever used as a lookup key — never displayed.
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "You cancelled the sign-in, so the account was not connected.",
  user_cancelled: "You cancelled the sign-in, so the account was not connected.",
  consent_required: "Permission wasn't granted, so the account was not connected.",
  "Missing code or state": "The storage provider didn't return a sign-in confirmation. Please try again.",
  "Invalid or expired OAuth state — please try again": "The sign-in took too long or wasn't started from this app. Please try again.",
  "Unknown provider": "That storage provider isn't supported.",
  "Failed to save connection": "We couldn't save the connection. Please try again.",
  "The storage provider rejected the sign-in. Please try again.": "The storage provider rejected the sign-in. Please try again.",
  server_error: "The storage provider had a problem. Please try again later.",
  temporarily_unavailable: "The storage provider is temporarily unavailable. Please try again later.",
};

export const OAUTH_GENERIC_ERROR = "The sign-in was cancelled or failed, so the account was not connected. Please try again.";

/** Map an `error` deep-link param to a fixed message (unknown values → generic). */
export function oauthErrorMessage(error: unknown): string {
  if (typeof error !== "string") return OAUTH_GENERIC_ERROR;
  return Object.prototype.hasOwnProperty.call(OAUTH_ERROR_MESSAGES, error)
    ? OAUTH_ERROR_MESSAGES[error]!
    : OAUTH_GENERIC_ERROR;
}

export type OAuthCompletion =
  | { ok: true; connectionId: number; name: string }
  | { ok: false; message: string };

// Settled results by callback code. On native the returning deep link can be
// seen both by the add-cloud screen (openAuthSessionAsync) and by the
// oauth-success route; both get the same single /oauth/complete call.
const completions = new Map<string, Promise<OAuthCompletion>>();

const NOT_FROM_THIS_DEVICE =
  "This sign-in wasn't started from this device, or it took too long. " +
  "The account was not connected — please connect it again from Settings.";

/**
 * Confirm the pending connection named by the callback redirect. Resolves to
 * an error result (never throws); on any failure the connection is not added.
 */
export function completeOAuthConnection(params: {
  provider: string;
  code: string;
  connectionId?: number | null;
}): Promise<OAuthCompletion> {
  const existing = completions.get(params.code);
  if (existing) return existing;
  const run = (async (): Promise<OAuthCompletion> => {
    const nonce = await readOAuthNonce(params.provider);
    if (!nonce) return { ok: false, message: NOT_FROM_THIS_DEVICE };
    try {
      const result = await completeOAuth({
        nonce,
        code: params.code,
        ...(params.connectionId ? { connectionId: params.connectionId } : {}),
      });
      return { ok: true, connectionId: result.connectionId, name: result.name };
    } catch (e) {
      return { ok: false, message: getUserFacingMessage(e, "Could not finish connecting the account. Please try again.") };
    } finally {
      // One-time: never reuse a nonce, whatever the outcome.
      await forgetOAuthNonce(params.provider);
    }
  })();
  completions.set(params.code, run);
  return run;
}
