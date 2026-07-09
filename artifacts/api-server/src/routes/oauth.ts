import { Router } from "express";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { db } from "@workspace/db";
import { cloudConnectionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, JWT_SECRET } from "../middlewares/auth.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { getPublicBaseUrl } from "../lib/appUrl.js";
import { fetchAccountIdentity } from "../lib/cloudIdentity.js";

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

interface OAuthState {
  userId: number;
  provider: string;
  name: string;
  platform: "web" | "native";
  uploadPath: string;
  verifier: string;
}

function signState(s: OAuthState): string {
  return jwt.sign(
    // The PKCE verifier is the one secret in the state. The state travels as a
    // query param through the OAuth provider and redirect URLs (logs, Referer),
    // so we encrypt the verifier — only our server can recover it, keeping PKCE's
    // proof-of-possession actually secret rather than readable in the JWT body.
    { sub: String(s.userId), p: s.provider, n: s.name, pf: s.platform, up: s.uploadPath, v: encrypt(s.verifier) },
    JWT_SECRET,
    { expiresIn: "10m" }
  );
}

function verifyState(state: string): OAuthState | null {
  try {
    const d = jwt.verify(state, JWT_SECRET, { algorithms: ["HS256"] }) as Record<string, string>;
    return {
      userId: Number(d["sub"]),
      provider: d["p"] ?? "",
      name: d["n"] ?? "",
      platform: d["pf"] === "native" ? "native" : "web",
      uploadPath: d["up"] ?? "/KKamera",
      verifier: d["v"] ? decrypt(d["v"]) : "",
    };
  } catch {
    return null;
  }
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
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as any;
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
      uploadPath: z.string().trim().max(500).optional(),
    }).safeParse(req.body ?? {});
    if (!parsedBody.success) { res.status(400).json({ message: "Invalid request" }); return; }
    const name = parsedBody.data.name ?? cfg.label;
    const platform = parsedBody.data.platform ?? "native";
    const uploadPath = parsedBody.data.uploadPath ?? "/KKamera";

    const verifier = generateVerifier();
    const challenge = generateChallenge(verifier);

    const state = signState({
      userId: req.userId!,
      provider,
      name,
      platform: platform === "native" ? "native" : "web",
      uploadPath,
      verifier,
    });

    const redirectUri = getCallbackUrl(provider);
    const authorizeUrl = buildAuthorizeUrl(provider, cfg, redirectUri, state, challenge);

    res.json({ authorizeUrl, state });
  } catch (err) {
    req.log.error({ err }, "OAuth initiate error");
    res.status(500).json({ message: "Failed to initiate OAuth" });
  }
});

// GET /api/oauth/:provider/callback — OAuth provider redirects here
router.get("/oauth/:provider/callback", async (req, res) => {
  const provider = String(req.params["provider"] ?? "");
  const { code, state, error } = req.query as Record<string, string>;

  const errorRedirect = (msg: string) => {
    res.redirect(`/oauth-error?error=${encodeURIComponent(msg)}&provider=${encodeURIComponent(provider)}`);
  };

  if (error) { errorRedirect(error); return; }
  if (!code || !state) { errorRedirect("Missing code or state"); return; }

  const entry = verifyState(state);
  if (!entry || entry.provider !== provider) {
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

    let conn: typeof cloudConnectionsTable.$inferSelect | undefined;

    // Reconnecting the SAME account refreshes that connection in place (keeps its
    // id, so any saved upload-target selection stays valid) rather than stacking
    // a duplicate. A different account of the same provider falls through to a
    // fresh insert below.
    if (identity.accountId) {
      const [existing] = await db.select().from(cloudConnectionsTable).where(and(
        eq(cloudConnectionsTable.userId, entry.userId),
        eq(cloudConnectionsTable.type, provider),
        eq(cloudConnectionsTable.accountId, identity.accountId),
      )).limit(1);
      if (existing) {
        [conn] = await db.update(cloudConnectionsTable).set({
          name: entry.name,
          uploadPath: entry.uploadPath,
          accessTokenEncrypted: encrypt(tokens.access_token),
          // Keep the prior refresh token if the provider didn't return a new one.
          refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : existing.refreshToken,
          tokenExpiry: expiry,
          accountLabel: identity.accountLabel,
          active: true,
        }).where(eq(cloudConnectionsTable.id, existing.id)).returning();
      }
    } else {
      // Identity unknown — fall back to name-based dedup so repeated reconnects
      // of the same (unidentifiable) account don't pile up duplicate rows.
      await db.update(cloudConnectionsTable)
        .set({ active: false })
        .where(and(
          eq(cloudConnectionsTable.userId, entry.userId),
          eq(cloudConnectionsTable.type, provider),
          eq(cloudConnectionsTable.name, entry.name),
          eq(cloudConnectionsTable.active, true),
        ));
    }

    if (!conn) {
      [conn] = await db.insert(cloudConnectionsTable).values({
        userId: entry.userId,
        type: provider,
        name: entry.name,
        uploadPath: entry.uploadPath,
        accountId: identity.accountId,
        accountLabel: identity.accountLabel,
        accessTokenEncrypted: encrypt(tokens.access_token),
        refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        tokenExpiry: expiry,
        active: true,
      }).returning();
    }

    if (!conn) { errorRedirect("Failed to save connection"); return; }

    const nameEnc = encodeURIComponent(entry.name);
    if (entry.platform === "native") {
      // Deep link back into the native app
      res.redirect(`kkamera://oauth-success?connectionId=${conn.id}&name=${nameEnc}&provider=${provider}`);
    } else {
      // Redirect to the success screen in the web/PWA app
      res.redirect(`/oauth-success?connectionId=${conn.id}&name=${nameEnc}&provider=${provider}`);
    }
  } catch (err: any) {
    req.log.error({ err }, "OAuth callback error");
    errorRedirect(String(err?.message ?? "Token exchange failed"));
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

// POST /api/oauth/:provider/refresh — refresh an expired access token
router.post("/oauth/:provider/refresh/:connectionId", requireAuth, async (req, res) => {
  try {
    const provider = String(req.params["provider"] ?? "");
    const connectionId = parseInt(String(req.params["connectionId"] ?? "0"));
    const cfg = PROVIDERS[provider];
    if (!cfg) { res.status(400).json({ message: "Unknown provider" }); return; }

    const [conn] = await db.select().from(cloudConnectionsTable)
      .where(and(eq(cloudConnectionsTable.id, connectionId), eq(cloudConnectionsTable.userId, req.userId!)))
      .limit(1);
    if (!conn?.refreshToken) { res.status(404).json({ message: "No refresh token found" }); return; }

    const decryptedRefresh = decryptToken(conn.refreshToken);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decryptedRefresh,
      client_id: process.env[cfg.clientIdEnv] ?? "",
      client_secret: process.env[cfg.clientSecretEnv] ?? "",
    });

    const tokenRes = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!tokenRes.ok) { res.status(502).json({ message: "Token refresh failed" }); return; }
    const tokens = await tokenRes.json() as any;

    await db.update(cloudConnectionsTable).set({
      accessTokenEncrypted: encrypt(tokens.access_token),
      tokenExpiry: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
      ...(tokens.refresh_token ? { refreshToken: encrypt(tokens.refresh_token) } : {}),
    }).where(eq(cloudConnectionsTable.id, connectionId));

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "OAuth refresh error");
    res.status(500).json({ message: "Refresh failed" });
  }
});

function decryptToken(enc: string): string {
  return decrypt(enc);
}

export default router;
