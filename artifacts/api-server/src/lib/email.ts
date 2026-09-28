import { createHash } from "crypto";
import { Resend } from "resend";
import { logger } from "./logger.js";
import { escapeHtml } from "./escapeHtml.js";
import { getPublicBaseUrl } from "./appUrl.js";
export { escapeHtml };

const FROM = process.env["EMAIL_FROM"] ?? "KKamera <noreply@kkamera.app>";

let client: Resend | null | undefined;

function getClient(): Resend | null {
  if (client === undefined) {
    const apiKey = process.env["RESEND_API_KEY"];
    client = apiKey ? new Resend(apiKey) : null;
  }
  return client;
}

/**
 * Log-safe recipient descriptor: the domain plus a short one-way hash (enough to
 * correlate log lines for one address) — never the address itself.
 */
function recipientForLog(to: string): { toDomain: string; toHash: string } {
  const normalized = to.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  return {
    toDomain: at >= 0 ? normalized.slice(at + 1) : "(invalid)",
    toHash: createHash("sha256").update(normalized).digest("hex").slice(0, 12),
  };
}

/** Send an email via Resend. Never throws; resolves true only if it was accepted. */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  const resend = getClient();
  if (!resend) {
    logger.warn("Email not sent — Resend not configured (RESEND_API_KEY)");
    return false;
  }
  const recipient = recipientForLog(opts.to);
  try {
    const { error } = await resend.emails.send({ from: FROM, ...opts });
    if (error) {
      logger.error({ error, ...recipient }, "Failed to send email");
      return false;
    }
    logger.info({ ...recipient, subject: opts.subject }, "Email sent");
    return true;
  } catch (err) {
    logger.error({ err, ...recipient }, "Failed to send email");
    return false;
  }
}

// ─── Templates ────────────────────────────────────────────────────────────────

function wrap(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d0b08; color: #ccc; margin: 0; padding: 0; }
  .outer { max-width: 560px; margin: 40px auto; padding: 0 20px; }
  .logo { font-size: 24px; font-weight: 700; color: #b19870; margin-bottom: 32px; }
  .card { background: #1a1710; border-radius: 16px; padding: 32px; border: 1px solid rgba(177,152,112,0.2); }
  h1 { color: #ffffff; font-size: 22px; margin: 0 0 16px; }
  p { color: #aaa; font-size: 15px; line-height: 24px; margin: 0 0 16px; }
  .btn { display: inline-block; background: #b19870; color: white; text-decoration: none; font-size: 15px; font-weight: 600; padding: 14px 28px; border-radius: 12px; margin: 16px 0; }
  .footer { color: #444; font-size: 12px; text-align: center; margin-top: 32px; line-height: 20px; }
</style></head>
<body>
  <div class="outer">
    <div class="logo">KKamera</div>
    <div class="card">
      <h1>${title}</h1>
      ${body}
    </div>
    <div class="footer">KKamera &mdash; Cloud Based Photography<br>
    You're receiving this because you have a KKamera account.<br>
    Questions? <a href="mailto:development@koastal.com.au" style="color:#b19870">development@koastal.com.au</a></div>
  </div>
</body>
</html>`;
}

export function welcomeEmail(name: string): { subject: string; html: string } {
  return {
    subject: "Welcome to KKamera 📷",
    html: wrap("Welcome, " + escapeHtml(name) + "!", `
      <p>Your account is all set. KKamera captures your photos and videos and instantly uploads them to your cloud storage — leaving no trace on your device.</p>
      <p>Your <strong style="color:#b19870">14-day free trial</strong> is active. Explore everything before deciding — no credit card required.</p>
      <a href="https://app.kkamera.app" class="btn">Open KKamera</a>
      <p>Add your cloud connections (Google Drive, OneDrive, Dropbox, FTP, WebDAV) in Settings → Upload to start shooting.</p>
    `),
  };
}

export function trialEndingEmail(name: string, daysLeft: number): { subject: string; html: string } {
  const days = `${daysLeft} day${daysLeft !== 1 ? "s" : ""}`;
  // No price here: it varies by App Store / Play storefront and country, so the
  // store's own subscription sheet is the only accurate source.
  return {
    subject: `Your KKamera trial ends in ${days}`,
    html: wrap("Your trial is almost over", `
      <p>Hi ${escapeHtml(name)},</p>
      <p>Your 14-day KKamera trial ends in <strong style="color:#b19870">${days}</strong>.</p>
      <p>To keep uploading directly to your cloud storage, subscribe from <strong>Settings → Subscription</strong> in the KKamera app. You'll see the price for your country before you confirm.</p>
      <a href="${getPublicBaseUrl()}/settings/subscription" class="btn">Open KKamera</a>
      <p>Your cloud connections and settings are kept either way.</p>
    `),
  };
}

export function coworkerInviteEmail(inviterName: string, referralCode: string): { subject: string; html: string } {
  const link = `https://app.kkamera.app/auth/register?ref=${encodeURIComponent(referralCode)}`;
  const safeName = escapeHtml(inviterName);
  const safeCode = escapeHtml(referralCode);
  // Strip CR/LF/tab from any user-derived value used in a header line, matching
  // the witness-notify subject handling.
  const subjectName = inviterName.replace(/[\r\n\t]+/g, " ").trim().slice(0, 100) || "Someone";
  return {
    subject: `${subjectName} invited you to KKamera 📷`,
    html: wrap(`${safeName} thinks you'd love KKamera`, `
      <p><strong style="color:#b19870">${safeName}</strong> uses KKamera — the privacy-first camera app that uploads photos and videos straight to your own cloud storage (Google Drive, OneDrive, Dropbox, FTP, WebDAV), leaving no trace on the device.</p>
      <p>Sign up with their invite and you'll get a <strong style="color:#b19870">14-day free trial</strong> — no credit card required.</p>
      <a href="${link}" class="btn">Accept Invite — Try Free</a>
      <p>Or enter the code <strong style="color:#b19870">${safeCode}</strong> when you register.</p>
    `),
  };
}

export function referralRewardEmail(name: string, freeYearsTotal: number): { subject: string; html: string } {
  return {
    subject: "You earned a free year of KKamera! 🎉",
    html: wrap("Free year unlocked!", `
      <p>Hi ${escapeHtml(name)},</p>
      <p>You've reached 5 successful referrals — we've added <strong style="color:#b19870">1 free year</strong> to your KKamera subscription!</p>
      <p>You now have <strong>${freeYearsTotal} free year${freeYearsTotal !== 1 ? "s" : ""}</strong> banked. Keep sharing to earn more — there's no limit!</p>
      <a href="https://app.kkamera.app/settings/subscription" class="btn">View Your Subscription</a>
    `),
  };
}
