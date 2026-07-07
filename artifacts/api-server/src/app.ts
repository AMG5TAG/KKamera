import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
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
// Native apps send no Origin header (allowed below), so CORS mainly bounds any
// browser-based tooling that talks to the API.
const ALLOWED_ORIGINS = process.env["ALLOWED_ORIGINS"]
  ? process.env["ALLOWED_ORIGINS"].split(",").map(o => o.trim())
  : null;

const APP_HOST = getPublicHost(); // e.g. "app.kkamera.app"

/** Hostname of an Origin header, ignoring port. */
function originHost(origin: string): string {
  try { return new URL(origin).hostname; } catch { return origin; }
}

// This is a JSON API for the native iOS/Android apps — it serves no HTML, so a
// content security policy is not required. Keep helmet's other hardening headers.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no Origin — native apps, server-to-server, health checks.
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
  // Auth is via the Authorization bearer header, not cookies.
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
