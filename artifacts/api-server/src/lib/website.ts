import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { logger } from "./logger.js";
import { isWebsiteRequest } from "./websitePaths.js";

/**
 * Serves the static KKamera website (artifacts/kkamera-website, built by Vite)
 * for every path outside /api, so the one production deployment answers both
 * www.kkamera.app (site) and app.kkamera.app/api (API).
 */

/** WEBSITE_DIR overrides; otherwise the Vite output next to this bundle (dist/index.mjs). */
function resolveWebsiteDir(): string {
  const override = process.env["WEBSITE_DIR"];
  if (override) return path.resolve(override);
  const bundleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(bundleDir, "..", "..", "kkamera-website", "dist", "public");
}

export function mountWebsite(app: Express): void {
  const dir = resolveWebsiteDir();
  const indexHtml = path.join(dir, "index.html");
  // The build moves the SPA shell to app.html and puts the showcase home page
  // at index.html; older builds only have the SPA at index.html.
  const appHtml = path.join(dir, "app.html");
  const spaShell = fs.existsSync(appHtml) ? appHtml : indexHtml;
  if (!fs.existsSync(indexHtml)) {
    logger.warn({ dir }, "Website build not found — serving the API only");
    return;
  }

  const assetsDir = path.join(dir, "assets") + path.sep;
  const serveStatic = express.static(dir, {
    // "/" is the showcase home page; /features and /how-it-works map to .html files.
    index: spaShell === appHtml ? "index.html" : false,
    extensions: spaShell === appHtml ? ["html"] : false,
    setHeaders(res, filePath) {
      // Vite fingerprints everything under /assets, so it can be cached forever.
      if (filePath.startsWith(assetsDir)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  });

  app.use((req, res, next) => {
    if (!isWebsiteRequest(req.method, req.path)) { next(); return; }
    serveStatic(req, res, next);
  });

  // Client-side routes (/privacy, /auth/register?ref=…) all load the SPA shell.
  app.use((req, res, next) => {
    if (!isWebsiteRequest(req.method, req.path)) { next(); return; }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(spaShell);
  });

  logger.info({ dir }, "Serving website");
}
