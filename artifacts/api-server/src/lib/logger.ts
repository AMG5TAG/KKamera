import pino from "pino";
import { redactSerializedError } from "./logRedaction.js";

const isProduction = process.env.NODE_ENV === "production";

/**
 * pino's standard error serializer plus secret redaction (an FTP `PASS …`
 * echoed in a server reply — see logRedaction.ts). Used by `logger` and passed
 * to pino-http in app.ts, whose child loggers would otherwise replace it with
 * the unredacted standard one.
 */
export function errSerializer(err: unknown): unknown {
  return redactSerializedError(pino.stdSerializers.err(err as Error));
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  serializers: { err: errSerializer },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
