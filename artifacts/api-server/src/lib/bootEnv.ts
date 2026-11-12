// Production boot checks. Imported FIRST by index.ts (ES modules evaluate in
// import order) so a misconfigured deployment fails with one clear message
// listing every missing variable, before @workspace/db throws on its own about
// DATABASE_URL. Development stays permissive: features degrade with warnings.
import { logger } from "./logger.js";

export const isProduction = process.env.NODE_ENV === "production";

/** Env vars a production instance must not start without. */
const REQUIRED_IN_PRODUCTION = [
  "DATABASE_URL",
  "SESSION_SECRET",
  // Every outbound email (verification codes, password reset) — without it
  // nobody can finish signing up.
  "RESEND_API_KEY",
  // Mirrors App Store / Play subscriptions; without it paying users get 402.
  "REVENUECAT_WEBHOOK_AUTH",
  // /subscriptions/sync and TRANSFER reconciliation.
  "REVENUECAT_SECRET_API_KEY",
] as const;

if (isProduction) {
  const missing = REQUIRED_IN_PRODUCTION.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    const message =
      `Missing required production environment variable(s): ${missing.join(", ")}. ` +
      "Set them in the deployment secrets (or unset NODE_ENV=production for local development).";
    logger.fatal({ missing }, message);
    throw new Error(message);
  }

  // Deliberately a loud warning rather than a refusal to boot: staff may enable
  // it on a staging deployment that also runs with NODE_ENV=production. On the
  // real production deployment it lets ANY sandbox (TestFlight / Play test
  // track) purchase grant access — use SANDBOX_IAP_USER_IDS for named testers.
  if (process.env["ALLOW_SANDBOX_IAP"] === "true") {
    logger.warn(
      "ALLOW_SANDBOX_IAP=true in production — sandbox (TestFlight / Play test) purchases grant access for EVERY user. " +
      "Unset it unless this is a staging deployment; use SANDBOX_IAP_USER_IDS for named testers.",
    );
  }
}
