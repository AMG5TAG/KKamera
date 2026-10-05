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
