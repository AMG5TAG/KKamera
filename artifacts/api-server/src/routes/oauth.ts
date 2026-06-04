import { Router } from "express";
import { createHash, randomBytes } from "crypto";
import { db } from "@workspace/db";
import { cloudConnectionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { encrypt, decrypt } from "../lib/crypto.js";

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

// ─── State store (in-memory, entries expire after 10 min) ───────────────────

interface OAuthState {
  userId: number;
  provider: string;
  name: string;
  platform: "web" | "native";
  uploadPath: string;
  verifier: string;
  expiresAt: number;
}

const stateStore = new Map<string, OAuthState>();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of stateStore) {
    if (val.expiresAt < now) stateStore.delete(key);
  }
}, 60_000);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCallbackUrl(req: import("express").Request, provider: string): string {
  const prod = process.env["REPLIT_DOMAINS"]?.split(",")[0];
  const dev = process.env["REPLIT_DEV_DOMAIN"];
  const domain = prod || dev;
  if (domain) return `https://${domain}/api/oauth/${provider}/callback`;
  return `${req.protocol}://${req.get("host")}/api/oauth/${provider}/callback`;
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

    const { name = cfg.label, platform = "web", uploadPath = "/KKamera" } = req.body as {
      name?: string; platform?: "web" | "native"; uploadPath?: string;
    };

    const state = randomBytes(20).toString("hex");
    const verifier = generateVerifier();
    const challenge = generateChallenge(verifier);

    stateStore.set(state, {
      userId: req.userId!,
      provider,
      name,
      platform: platform === "native" ? "native" : "web",
      uploadPath,
      verifier,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const redirectUri = getCallbackUrl(req, provider);
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
    res.redirect(`/oauth-error?error=${encodeURIComponent(msg)}&provider=${provider}`);
  };

  if (error) { errorRedirect(error); return; }
  if (!code || !state) { errorRedirect("Missing code or state"); return; }

  const entry = stateStore.get(state);
  if (!entry || entry.provider !== provider || entry.expiresAt < Date.now()) {
    errorRedirect("Invalid or expired OAuth state — please try again");
    return;
  }
  stateStore.delete(state);

  const cfg = PROVIDERS[provider];
  if (!cfg) { errorRedirect("Unknown provider"); return; }

  try {
    const redirectUri = getCallbackUrl(req, provider);
    const tokens = await exchangeCode(provider, cfg, code, redirectUri, entry.verifier);

    const expiry = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;

    const [conn] = await db.insert(cloudConnectionsTable).values({
      userId: entry.userId,
      type: provider,
      name: entry.name,
      uploadPath: entry.uploadPath,
      accessTokenEncrypted: encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      tokenExpiry: expiry,
      active: true,
    }).returning();

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
