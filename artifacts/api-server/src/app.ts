import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import { WebhookHandlers } from "./webhookHandlers.js";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { getPublicHost } from "./lib/appUrl.js";

const app: Express = express();

// Behind the Replit proxy: required so req.ip is the real client IP
// (rate limiting would otherwise share one bucket across ALL users) and
// req.protocol reflects https.
app.set("trust proxy", 1);

// Allowed origins: the canonical app host (app.kkamera.app, incl. subdomains) plus an
// optional explicit ALLOWED_ORIGINS whitelist; localhost is allowed in dev only.
const ALLOWED_ORIGINS = process.env["ALLOWED_ORIGINS"]
  ? process.env["ALLOWED_ORIGINS"].split(",").map(o => o.trim())
  : null;

const APP_HOST = getPublicHost(); // e.g. "app.kkamera.app"

/** Hostname of an Origin header, ignoring port. */
function originHost(origin: string): string {
  try { return new URL(origin).hostname; } catch { return origin; }
}

app.use(helmet({
  // Expo web / PWA needs cross-origin isolation disabled
  crossOriginEmbedderPolicy: false,
  // Content Security Policy: the API serves the Expo web build same-origin, so a
  // tight CSP is our main defence against XSS stealing the bearer token.
  //  - script-src 'self': the Expo export loads its bundle from same-origin files
  //    and the only inline <script> is non-executable JSON-LD (not subject to CSP).
  //  - style-src allows 'unsafe-inline' because React Native Web injects inline styles.
  //  - js.stripe.com / checkout.stripe.com are whitelisted for the optional Stripe.js
  //    + Checkout redirect flow.
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://js.stripe.com"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "blob:", "https:"],
      "font-src": ["'self'", "data:"],
      "connect-src": ["'self'", "https://api.stripe.com"],
      "frame-src": ["'self'", "https://js.stripe.com", "https://checkout.stripe.com"],
      "worker-src": ["'self'", "blob:"],
      "form-action": ["'self'", "https://checkout.stripe.com"],
      "frame-ancestors": ["'none'"],
      "base-uri": ["'self'"],
      "object-src": ["'none'"],
      "upgrade-insecure-requests": [],
    },
  },
}));

app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server (no origin) and Stripe webhooks
    if (!origin) return callback(null, true);
    const host = originHost(origin);
    // Canonical app host and its subdomains (e.g. app.kkamera.app)
    if (host === APP_HOST || host.endsWith(`.${APP_HOST}`)) {
      return callback(null, true);
    }
    // Explicit whitelist override (ALLOWED_ORIGINS)
    if (ALLOWED_ORIGINS && ALLOWED_ORIGINS.some(o => origin === o || host === originHost(o) || host.endsWith(`.${originHost(o)}`))) {
      return callback(null, true);
    }
    // Allow localhost in dev
    if (process.env.NODE_ENV !== "production" && (host === "localhost" || host === "127.0.0.1")) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  // Auth is via the Authorization bearer header, not cookies — so cross-origin
  // credentials (cookies) are intentionally NOT enabled.
  credentials: false,
}));

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  })
);

// Stripe webhook MUST be registered before express.json() so the body arrives as a raw Buffer
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature" });
      return;
    }
    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (err: any) {
      logger.error({ err }, "Stripe webhook error");
      res.status(400).json({ error: "Webhook processing error" });
    }
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// ─── Static web app (single-origin deployment) ────────────────────────────────
// Serve the Expo web export from this process so the published app and /api share
// one origin. The export's location varies with how the deploy is packaged, so
// probe candidates and use the first that actually contains a build. The
// production build (.replit) copies the export to ./web next to this bundle so it
// always ships together with the server, regardless of the deploy file layout.
const WEB_BUILD_CANDIDATES = [
  process.env["WEB_BUILD_DIR"],
  path.resolve(import.meta.dirname, "web"),                 // co-located with the server bundle (prod)
  path.resolve(import.meta.dirname, "../../kkamera/dist"),  // monorepo layout (local dev)
  path.resolve(process.cwd(), "artifacts/kkamera/dist"),    // run-from-repo-root fallback
].filter((d): d is string => !!d);

const WEB_BUILD_DIR = WEB_BUILD_CANDIDATES.find(
  (dir) => fs.existsSync(path.join(dir, "index.html"))
);

if (WEB_BUILD_DIR) {
  logger.info({ dir: WEB_BUILD_DIR }, "Serving web build");
  app.use(express.static(WEB_BUILD_DIR, { index: "index.html", maxAge: "1h" }));
  // SPA fallback: any non-API GET renders the app shell (expo-router handles the route)
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_BUILD_DIR, "index.html"));
  });
} else {
  // Loud, with the probed paths, so a misconfigured deploy is obvious in logs
  // instead of silently degrading to API-only (app routes 404 → "use Expo Go").
  logger.warn({ candidates: WEB_BUILD_CANDIDATES }, "No web build found in any candidate path — serving API only");
}

export default app;
