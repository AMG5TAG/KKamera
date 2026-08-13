import express, { type Express, type ErrorRequestHandler } from "express";
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
    // Allow localhost and Replit dev domains in dev
    if (process.env.NODE_ENV !== "production") {
      if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".replit.dev")) {
        return callback(null, true);
      }
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

// JSON/urlencoded bodies are small (auth, settings, etc.) — cap them so a huge
// payload can't exhaust memory. File uploads go through multer (multipart), not
// these parsers, so this limit doesn't affect them.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api", router);

// Central error handler — catches CORS rejections, multer errors (e.g. a file
// over the size cap), and any uncaught async throw. Never leak internal details
// or stack traces to the client; the full error is logged server-side.
const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) { next(err); return; }
  req.log?.error({ err }, "Unhandled request error");
  if (err?.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ message: "File is too large." });
    return;
  }
  if (typeof err?.message === "string" && err.message.startsWith("CORS:")) {
    res.status(403).json({ message: "Origin not allowed." });
    return;
  }
  res.status(500).json({ message: "Internal server error" });
};
app.use(errorHandler);

export default app;
