import { Router, type IRouter } from "express";
import { APP_LINK_PATHS, buildAppLink, type AppLink } from "../lib/appLinks.js";
import { escapeHtml } from "../lib/escapeHtml.js";

// Mounted at the root (not /api): these are the browser landing pages for the
// https://app.kkamera.app/... links in emails. See lib/appLinks.ts.
const router: IRouter = Router();

router.get(APP_LINK_PATHS, (req, res) => {
  const link = buildAppLink(req.path, req.query as Record<string, unknown>);
  if (!link) {
    res.status(404).end();
    return;
  }
  // The reset token is in the URL: never cache it or leak it via Referer.
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.type("html").send(renderAppLinkPage(link));
});

/** Self-contained HTML page that opens the deep link (auto + button). */
function renderAppLinkPage(link: AppLink): string {
  const title = escapeHtml(link.title);
  const href = escapeHtml(link.deepLink);
  const note = link.valid
    ? "If KKamera didn't open, tap the button below on the phone where the app is installed."
    : "This link is incomplete or has expired. Request a new one from the KKamera app.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${title} · KKamera</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0d0b08; color: #f3ede3; font: 16px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width: 420px; padding: 32px 24px; text-align: center; }
  h1 { color: #b19870; font-size: 24px; margin: 0 0 12px; }
  p { color: #c3b091; margin: 0 0 24px; }
  a.btn { display: inline-block; background: #b19870; color: #0d0b08; text-decoration: none;
          font-weight: 600; padding: 14px 28px; border-radius: 12px; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>${escapeHtml(note)}</p>
  ${link.valid ? `<a class="btn" href="${href}">Open KKamera</a>` : ""}
</main>
${link.valid ? `<script>window.location.replace(${JSON.stringify(link.deepLink).replace(/</g, "\\u003c")});</script>` : ""}
</body>
</html>`;
}

export default router;
