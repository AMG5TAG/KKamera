import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { WebhookHandlers } from "./webhookHandlers.js";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app: Express = express();

// Allowed origins: explicit whitelist in prod, permissive in dev
const ALLOWED_ORIGINS = process.env["ALLOWED_ORIGINS"]
  ? process.env["ALLOWED_ORIGINS"].split(",").map(o => o.trim())
  : null;

const replitDomain = process.env["REPLIT_DOMAINS"]?.split(",")[0];

app.use(helmet({
  // Expo web / PWA needs cross-origin isolation disabled
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));

app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server (no origin) and Stripe webhooks
    if (!origin) return callback(null, true);
    // Dev: allow all
    if (!ALLOWED_ORIGINS && !replitDomain) return callback(null, true);
    // Explicit whitelist
    if (ALLOWED_ORIGINS && ALLOWED_ORIGINS.some(o => origin === o || origin.endsWith(`.${o}`))) {
      return callback(null, true);
    }
    // Replit domain
    if (replitDomain && (origin.endsWith(`.${replitDomain}`) || origin === `https://${replitDomain}`)) {
      return callback(null, true);
    }
    // Allow localhost in dev
    if (process.env.NODE_ENV !== "production" && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
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

export default app;
