import { Router } from "express";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { cloudConnectionsTable } from "@workspace/db";
import { eq, and, desc, inArray, isNull, ne } from "drizzle-orm";
import { requireAuth, JWT_SECRET } from "../middlewares/auth.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { getPublicBaseUrl } from "../lib/appUrl.js";
import { fetchAccountIdentity } from "../lib/cloudIdentity.js";
import { DEFAULT_UPLOAD_PATH, hasParentSegment, normalizeUploadPath } from "../lib/cloudUploadPolicy.js";
import { purgeExpiredPendingConnections, revokeRemovedConnectionIfUnshared } from "../lib/cloudUpload.js";
import {
  PENDING_CONNECTION_TTL_MS, bindingHashFor, generateCallbackCode, generateOAuthNonce, hashOAuthNonce,
  isPendingExpired, isWellFormedCallbackCode, isWellFormedNonce, isWellFormedNonceHash, pendingBindingHash,
} from "../lib/oauthPending.js";

const router = Router();

// ─── PKCE ────────────────────────────────────────────────────────────────────

function generateVerifier(): string {
  return randomBytes(64).toString("base64url");
}

function generateChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ─── Provider config ─────────────────────────────────────────────────────────

interface ProviderConfig {
  label: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  pkce: boolean;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  googledrive: {
    label: "Google Drive",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: "https://www.googleapis.com/auth/drive.file",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    pkce: true,
  },
  onedrive: {
    label: "OneDrive",
    // Use /common so both personal Microsoft accounts and work/school (M365 org)
    // accounts can sign in. The Azure app registration's "Supported account types"
    // must be set to "Accounts in any organizational directory and personal
    // Microsoft accounts" to match, otherwise /common returns AADSTS700016
    // (unauthorized_client).
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: "Files.ReadWrite offline_access",
    clientIdEnv: "ONEDRIVE_CLIENT_ID",
    clientSecretEnv: "ONEDRIVE_CLIENT_SECRET",
    pkce: true,
  },
  dropbox: {
    label: "Dropbox",
    authUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    scopes: "",
    clientIdEnv: "DROPBOX_CLIENT_ID",
    clientSecretEnv: "DROPBOX_CLIENT_SECRET",
    pkce: true,
  },
};

// ─── OAuth state (stateless, signed JWT) ─────────────────────────────────────
// The state travels with the redirect as a short-lived signed token, so the
// callback can land on any instance (autoscale) or survive a restart.
//
// The state names the initiating user, but that alone would let anyone who
// sends their authorize URL to someone else link THAT person's cloud account
// to their own KKamera account (account-linking CSRF). So the state also
// carries the hash of a one-time nonce that only the initiating device holds,
// and the callback just parks the tokens on a pending row that /oauth/complete
// confirms — see lib/oauthPending.ts.

interface OAuthState {
  userId: number;
  provider: string;
  name: string;
  platform: "web" | "native";
  uploadPath: string;
  verifier: string;
  /** hashOAuthNonce(nonce) — the nonce itself stays on the initiating device. */
  nonceHash: string;
}

const OAUTH_STATE_TYP = "oauth-state";
const OAUTH_STATE_AUDIENCE = "kkamera-oauth-state";

function signState(s: OAuthState): string {
  return jwt.sign(
    // The PKCE verifier is the one secret in the state. The state travels as a
    // query param through the OAuth provider and redirect URLs (logs, Referer),
    // so we encrypt the verifier — only our server can recover it, keeping PKCE's
    // proof-of-possession actually secret rather than readable in the JWT body.
    // `typ` + a state-only audience keep this token and a session JWT (same
    // secret, aud "kkamera-session") from ever verifying as each other.
    { typ: OAUTH_STATE_TYP, sub: String(s.userId), p: s.provider, n: s.name, pf: s.platform, up: s.uploadPath, v: encrypt(s.verifier), nh: s.nonceHash },
    JWT_SECRET,
    { algorithm: "HS256", audience: OAUTH_STATE_AUDIENCE, expiresIn: "10m" }
  );
}

function verifyState(state: string): OAuthState | null {
  try {
    const d = jwt.verify(state, JWT_SECRET, { algorithms: ["HS256"], audience: OAUTH_STATE_AUDIENCE }) as Record<string, string>;
    if (d["typ"] !== OAUTH_STATE_TYP) return null;
    return {
      userId: Number(d["sub"]),
      provider: d["p"] ?? "",
      name: d["n"] ?? "",
      platform: d["pf"] === "native" ? "native" : "web",
      uploadPath: d["up"] ?? "/KKamera",
      verifier: d["v"] ? decrypt(d["v"]) : "",
      nonceHash: d["nh"] ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Platform hint from a state token that failed verification (expired, wrong
 * signature, garbled). Read WITHOUT verifying: it only picks which surface the
 * error page opens on, and a forged value just sends the forger's own browser
 * somewhere harmless. Anything unreadable defaults to the native deep link —
 * the web app loads fine from a kkamera:// miss far less often than a native
 * user gets stranded inside the in-app auth browser on a web page.
 */
function statePlatformHint(state: string | undefined): "web" | "native" {
  if (!state) return "native";
  try {
    const d = jwt.decode(state);
    if (d && typeof d === "object" && (d as Record<string, unknown>)["pf"] === "web") return "web";
  } catch { /* fall through */ }
  return "native";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCallbackUrl(provider: string): string {
  // Always the canonical app origin (app.kkamera.app) so it matches the redirect URIs
  // registered with each OAuth provider, regardless of where the server runs.
  return `${getPublicBaseUrl()}/api/oauth/${provider}/callback`;
}

function buildAuthorizeUrl(provider: string, cfg: ProviderConfig, redirectUri: string, state: string, challenge: string): string {
  const p = new URLSearchParams({
    client_id: process.env[cfg.clientIdEnv] ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });

  if (cfg.pkce) {
    p.set("code_challenge", challenge);
    p.set("code_challenge_method", "S256");
  }

  if (provider === "googledrive") {
    p.set("scope", cfg.scopes);
    p.set("access_type", "offline");
    p.set("prompt", "consent");
  } else if (provider === "onedrive") {
    p.set("scope", cfg.scopes);
    p.set("response_mode", "query");
  } else if (provider === "dropbox") {
    p.set("token_access_type", "offline");
  }

  return `${cfg.authUrl}?${p}`;
}

async function exchangeCode(
  provider: string,
  cfg: ProviderConfig,
  code: string,
  redirectUri: string,
  verifier: string
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: process.env[cfg.clientIdEnv] ?? "",
    client_secret: process.env[cfg.clientSecretEnv] ?? "",
    code_verifier: verifier,
  });

  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    // Bound the provider call so a stalled token endpoint can't hang the request.
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as any;
}

// Extract a safe, human-readable reason from a callback failure. Providers put a
// descriptive `error_description` (e.g. "AADSTS7000215: Invalid client secret") in
// their FAILED token responses — never a token — so echoing a bounded copy back to
// the user is safe and far more actionable than a generic message.
function oauthErrorReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/"error_description"\s*:\s*"([^"]{0,300})"/);
  if (m?.[1]) return m[1].replace(/\s+/g, " ").trim();
  if (/Token exchange failed/i.test(raw)) return "The storage provider rejected the sign-in. Please try again.";
  return "Could not complete the connection. Please try again.";
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /api/oauth/:provider/initiate  — authenticated, returns authorizeUrl
router.post("/oauth/:provider/initiate", requireAuth, async (req, res) => {
  try {
    const provider = String(req.params["provider"] ?? "");
    const cfg = PROVIDERS[provider];
    if (!cfg) { res.status(400).json({ message: "Unknown OAuth provider" }); return; }

    const clientId = process.env[cfg.clientIdEnv];
    if (!clientId) {
      res.status(503).json({
        message: `${cfg.label} OAuth is not configured. Set the ${cfg.clientIdEnv} and ${cfg.clientSecretEnv} environment variables.`,
        missingEnv: [cfg.clientIdEnv, cfg.clientSecretEnv],
      });
      return;
    }

    // Validate + bound the client-supplied fields — they flow into the stored
    // connection name and upload path.
    const parsedBody = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      platform: z.enum(["web", "native"]).optional(),
      uploadPath: z.string().trim().max(500)
        .refine((p) => !hasParentSegment(p), { message: 'Upload folder must not contain ".."' })
        .optional(),
    }).safeParse(req.body ?? {});
    if (!parsedBody.success) {
      const issue = parsedBody.error.errors[0];
      res.status(400).json({ message: issue?.path[0] === "uploadPath" ? issue.message : "Invalid request" });
      return;
    }
    const name = parsedBody.data.name ?? cfg.label;
    const platform = parsedBody.data.platform ?? "native";
    const uploadPath = normalizeUploadPath(parsedBody.data.uploadPath || DEFAULT_UPLOAD_PATH);

    void purgeExpiredPendingConnections();

    const verifier = generateVerifier();
    const challenge = generateChallenge(verifier);
    // Returned only to this (authenticated) caller; the app keeps it on the
    // device and presents it to /oauth/complete. Only its hash is in the state.
    const nonce = generateOAuthNonce();

    const state = signState({
      userId: req.userId!,
      provider,
      name,
      platform: platform === "native" ? "native" : "web",
      uploadPath,
      verifier,
      nonceHash: hashOAuthNonce(nonce),
    });

    const redirectUri = getCallbackUrl(provider);
    const authorizeUrl = buildAuthorizeUrl(provider, cfg, redirectUri, state, challenge);

    res.json({ authorizeUrl, state, nonce });
  } catch (err) {
    req.log.error({ err }, "OAuth initiate error");
    res.status(500).json({ message: "Failed to initiate OAuth" });
  }
});

// GET /api/oauth/:provider/callback — OAuth provider redirects here
router.get("/oauth/:provider/callback", async (req, res) => {
  const provider = String(req.params["provider"] ?? "");
  const { code, state, error } = req.query as Record<string, string>;

  // Recover the platform from the signed state up front so failures return to the
  // right surface: the native app via the kkamera:// deep link, or the web app's
  // /oauth-error page. Previously EVERY error redirected to the web page, which on
  // the native app got stuck inside the in-app auth browser (the kkamera:// return
  // scheme never matched) instead of handing control back with a reason.
  const entry = state ? verifyState(state) : null;
  // When the state can't be verified (expired after 10 min, tampered, missing)
  // fall back to an unverified read of its platform, defaulting to native.
  const platform = entry?.platform ?? statePlatformHint(state);

  const errorRedirect = (msg: string) => {
    const qs = `error=${encodeURIComponent(msg)}&provider=${encodeURIComponent(provider)}`;
    res.redirect(platform === "native" ? `kkamera://oauth-error?${qs}` : `/oauth-error?${qs}`);
  };

  if (error) { errorRedirect(error); return; }
  if (!code || !state) { errorRedirect("Missing code or state"); return; }

  if (!entry || entry.provider !== provider || !isWellFormedNonceHash(entry.nonceHash)) {
    errorRedirect("Invalid or expired OAuth state — please try again");
    return;
  }

  const cfg = PROVIDERS[provider];
  if (!cfg) { errorRedirect("Unknown provider"); return; }

  try {
    const redirectUri = getCallbackUrl(provider);
    const tokens = await exchangeCode(provider, cfg, code, redirectUri, entry.verifier);

    const expiry = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;

    // Identify the account so a personal and a business account of the same
    // provider can coexist as separate connections (best-effort; may be null).
    const identity = await fetchAccountIdentity(provider, tokens.access_token);

    // Park the tokens on a PENDING row. It is not listed, never uploads and is
    // not merged into an existing connection until /oauth/complete proves the
    // request comes from the device that started this flow (initiate nonce)
    // AND that this browser finished it (the one-time code minted here, which
    // goes only into this redirect). Unconfirmed rows expire and are purged.
    const callbackCode = generateCallbackCode();
    const [pending] = await db.insert(cloudConnectionsTable).values({
      userId: entry.userId,
      type: provider,
      name: entry.name,
      uploadPath: entry.uploadPath,
      accountId: identity.accountId,
      accountLabel: identity.accountLabel,
      accessTokenEncrypted: encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      tokenExpiry: expiry,
      active: false,
      pendingNonceHash: pendingBindingHash(entry.nonceHash, callbackCode),
      pendingExpiresAt: new Date(Date.now() + PENDING_CONNECTION_TTL_MS),
    }).returning({ id: cloudConnectionsTable.id });

    if (!pending) { errorRedirect("Failed to save connection"); return; }

    // Only non-secret values: the pending id, the provider, and the one-time
    // code, which is useless without the nonce held by the initiating device.
    const qs = `connectionId=${pending.id}&code=${encodeURIComponent(callbackCode)}&provider=${encodeURIComponent(provider)}`;
    if (entry.platform === "native") {
      // Deep link back into the native app
      res.redirect(`kkamera://oauth-success?${qs}`);
    } else {
      // Redirect to the success screen in the web/PWA app, which completes it
      res.redirect(`/oauth-success?${qs}`);
    }
  } catch (err: any) {
    req.log.error({ err }, "OAuth callback error");
    // Surface the provider's own failure reason (e.g. an AADSTS code) when we can
    // extract it. It appears only in FAILED token responses, which carry no access
    // tokens, so it's safe to show — and gives the user (and support) an actionable
    // message instead of a dead-end "try again".
    errorRedirect(oauthErrorReason(err));
  }
});

// POST /api/oauth/complete — authenticated; confirms a pending connection
const completeSchema = z.object({
  nonce: z.string().refine(isWellFormedNonce),
  code: z.string().refine(isWellFormedCallbackCode),
  connectionId: z.number().int().positive().optional(),
});

type ConnectionRow = typeof cloudConnectionsTable.$inferSelect;

const COMPLETE_FAILED = "This connection request has expired or was started on another device. Please connect the account again from Settings.";

router.post("/oauth/complete", requireAuth, async (req, res) => {
  try {
    const parsed = completeSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ message: "Invalid request" }); return; }
    const { nonce, code, connectionId } = parsed.data;
    const userId = req.userId!;
    const binding = bindingHashFor(nonce, code);

    void purgeExpiredPendingConnections();

    // Looked up by (user, binding hash): a pending row created from someone
    // else's authorize link belongs to that other user, and the binding needs
    // both the initiator's nonce and this browser's callback code.
    const [pending] = await db.select().from(cloudConnectionsTable).where(and(
      eq(cloudConnectionsTable.userId, userId),
      eq(cloudConnectionsTable.pendingNonceHash, binding),
      connectionId ? eq(cloudConnectionsTable.id, connectionId) : undefined,
    )).limit(1);
    if (!pending) { res.status(404).json({ message: COMPLETE_FAILED }); return; }

    if (isPendingExpired(pending.pendingExpiresAt)) {
      const [gone] = await db.delete(cloudConnectionsTable).where(and(
        eq(cloudConnectionsTable.id, pending.id),
        eq(cloudConnectionsTable.pendingNonceHash, binding),
      )).returning();
      if (gone) void revokeRemovedConnectionIfUnshared(gone);
      res.status(410).json({ message: COMPLETE_FAILED });
      return;
    }

    const conn = await db.transaction(async (tx): Promise<ConnectionRow | undefined> => {
      // Reconnecting the SAME account refreshes that connection in place (keeps
      // its id, so any saved upload-target selection stays valid) rather than
      // stacking a duplicate. "Same account" is the provider's account id when
      // the identity lookup worked; when it didn't, an unidentified connection
      // of this provider with the same label/name. Any further matches are stale
      // duplicates (e.g. rows the old code only deactivated, still holding live
      // tokens) and are DELETED. Their grant is not revoked — it is the same
      // account's grant the fresh tokens belong to. A different account
      // activates the pending row as a new connection.
      const sameAccount = pending.accountId
        ? eq(cloudConnectionsTable.accountId, pending.accountId)
        : and(
            isNull(cloudConnectionsTable.accountId),
            pending.accountLabel
              ? eq(cloudConnectionsTable.accountLabel, pending.accountLabel)
              : eq(cloudConnectionsTable.name, pending.name),
          );
      const matches = await tx.select().from(cloudConnectionsTable).where(and(
        eq(cloudConnectionsTable.userId, userId),
        eq(cloudConnectionsTable.type, pending.type),
        isNull(cloudConnectionsTable.pendingNonceHash),
        ne(cloudConnectionsTable.id, pending.id),
        sameAccount,
      )).orderBy(desc(cloudConnectionsTable.active), desc(cloudConnectionsTable.createdAt));

      const [existing, ...superseded] = matches;
      if (!existing) {
        // New account: confirm the pending row itself. Conditional on the
        // binding so two concurrent completes can't both succeed.
        const [activated] = await tx.update(cloudConnectionsTable).set({
          active: true,
          pendingNonceHash: null,
          pendingExpiresAt: null,
        }).where(and(
          eq(cloudConnectionsTable.id, pending.id),
          eq(cloudConnectionsTable.pendingNonceHash, binding),
        )).returning();
        return activated;
      }

      // Existing account: consume the pending row first (the claim), then move
      // its tokens onto the existing connection.
      const [claimed] = await tx.delete(cloudConnectionsTable).where(and(
        eq(cloudConnectionsTable.id, pending.id),
        eq(cloudConnectionsTable.pendingNonceHash, binding),
      )).returning({ id: cloudConnectionsTable.id });
      if (!claimed) return undefined;
      const [updated] = await tx.update(cloudConnectionsTable).set({
        name: pending.name,
        uploadPath: pending.uploadPath,
        accessTokenEncrypted: pending.accessTokenEncrypted,
        // Keep the prior refresh token if the provider didn't return a new one.
        refreshToken: pending.refreshToken ?? existing.refreshToken,
        tokenExpiry: pending.tokenExpiry,
        accountId: pending.accountId ?? existing.accountId,
        accountLabel: pending.accountLabel ?? existing.accountLabel,
        active: true,
      }).where(eq(cloudConnectionsTable.id, existing.id)).returning();
      // Deleted concurrently: roll back so the pending row survives and a
      // retry activates it as a new connection instead of losing the tokens.
      if (!updated) throw new Error("Connection to refresh disappeared during OAuth completion");
      if (superseded.length > 0) {
        await tx.delete(cloudConnectionsTable).where(and(
          eq(cloudConnectionsTable.userId, userId),
          inArray(cloudConnectionsTable.id, superseded.map((c) => c.id)),
        ));
      }
      return updated;
    });

    if (!conn) { res.status(404).json({ message: COMPLETE_FAILED }); return; }
    res.json({ connectionId: conn.id, type: conn.type, name: conn.name, accountLabel: conn.accountLabel ?? null });
  } catch (err) {
    req.log.error({ err }, "OAuth complete error");
    res.status(500).json({ message: "Could not complete the connection. Please try again." });
  }
});

// GET /api/oauth/status — check which providers are configured
router.get("/oauth/status", requireAuth, (_req, res) => {
  const status: Record<string, { configured: boolean; label: string }> = {};
  for (const [key, cfg] of Object.entries(PROVIDERS)) {
    status[key] = {
      label: cfg.label,
      configured: !!process.env[cfg.clientIdEnv] && !!process.env[cfg.clientSecretEnv],
    };
  }
  res.json(status);
});

export default router;
