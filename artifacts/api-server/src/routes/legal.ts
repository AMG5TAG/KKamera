import { Router, type IRouter } from "express";
import {
  ACCOUNT_DELETION_HTML,
  LEGAL_PAGE_CSP,
  PRIVACY_HTML,
  TERMS_HTML,
} from "../lib/legalPages.js";

// Public legal pages linked from the App Store / Google Play listings and the
// app. Mounted at the root (https://app.kkamera.app/privacy, like the email
// app-link pages) and also under /api/legal/* (app.ts). Static HTML only.
const router: IRouter = Router();

const PAGES: Record<string, string> = {
  "/privacy": PRIVACY_HTML,
  "/terms": TERMS_HTML,
  "/account-deletion": ACCOUNT_DELETION_HTML,
};

for (const [path, html] of Object.entries(PAGES)) {
  router.get(path, (_req, res) => {
    // Helmet's global CSP is off (JSON API); these pages get a strict one.
    res.set("Content-Security-Policy", LEGAL_PAGE_CSP);
    res.set("Cache-Control", "public, max-age=3600");
    res.type("html").send(html);
  });
}

export default router;
