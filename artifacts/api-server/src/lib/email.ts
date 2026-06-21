import { Resend } from "resend";
import { logger } from "./logger.js";

const FROM = process.env["EMAIL_FROM"] ?? "KKamera <noreply@kkamera.app>";

/** Escape user-controlled text before interpolating into email HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let client: Resend | null | undefined;

function getClient(): Resend | null {
  if (client === undefined) {
    const apiKey = process.env["RESEND_API_KEY"];
    client = apiKey ? new Resend(apiKey) : null;
  }
  return client;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const resend = getClient();
  if (!resend) {
    logger.warn("Email not sent — Resend not configured (RESEND_API_KEY)");
    return;
  }
  try {
    const { error } = await resend.emails.send({ from: FROM, ...opts });
    if (error) {
      logger.error({ error, to: opts.to }, "Failed to send email");
      return;
    }
    logger.info({ to: opts.to, subject: opts.subject }, "Email sent");
  } catch (err) {
    logger.error({ err, to: opts.to }, "Failed to send email");
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
    Questions? <a href="mailto:support@kkamera.app" style="color:#b19870">support@kkamera.app</a></div>
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
      <a href="https://kkamera.app" class="btn">Open KKamera</a>
      <p>Add your cloud connections (Google Drive, OneDrive, Dropbox, FTP, WebDAV) in Settings → Upload to start shooting.</p>
    `),
  };
}

export function trialEndingEmail(name: string, daysLeft: number): { subject: string; html: string } {
  return {
    subject: `Your KKamera trial ends in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}`,
    html: wrap("Your trial is almost over", `
      <p>Hi ${escapeHtml(name)},</p>
      <p>Your 14-day KKamera trial ends in <strong style="color:#b19870">${daysLeft} day${daysLeft !== 1 ? "s" : ""}</strong>.</p>
      <p>Subscribe now to keep uploading directly to your cloud storage — just <strong>$25/year</strong>, less than 7¢ a day.</p>
      <a href="https://kkamera.app/settings/subscription" class="btn">Subscribe — $25/year</a>
      <p>Don't lose access to your camera uploads. Your existing cloud connections and settings will be preserved.</p>
    `),
  };
}

export function subscriptionActiveEmail(name: string): { subject: string; html: string } {
  return {
    subject: "KKamera subscription confirmed",
    html: wrap("Subscription active", `
      <p>Hi ${escapeHtml(name)},</p>
      <p>Your KKamera subscription is now active. You have full access for the next 12 months.</p>
      <p>Thank you for supporting KKamera — your subscription helps us keep the app ad-free and privacy-first.</p>
      <a href="https://kkamera.app" class="btn">Open KKamera</a>
    `),
  };
}

export function subscriptionCancelledEmail(name: string, accessUntil: string): { subject: string; html: string } {
  return {
    subject: "KKamera subscription cancelled",
    html: wrap("Subscription cancelled", `
      <p>Hi ${escapeHtml(name)},</p>
      <p>Your KKamera subscription has been cancelled. You'll retain full access until <strong style="color:#b19870">${escapeHtml(accessUntil)}</strong>.</p>
      <p>If you change your mind, you can resubscribe anytime from Settings → Subscription.</p>
      <a href="https://kkamera.app/settings/subscription" class="btn">Resubscribe</a>
    `),
  };
}

export function coworkerInviteEmail(inviterName: string, referralCode: string): { subject: string; html: string } {
  const link = `https://kkamera.app/register?ref=${encodeURIComponent(referralCode)}`;
  const safeName = escapeHtml(inviterName);
  const safeCode = escapeHtml(referralCode);
  return {
    subject: `${inviterName} invited you to KKamera 📷`,
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
      <a href="https://kkamera.app/settings/subscription" class="btn">View Your Subscription</a>
    `),
  };
}
