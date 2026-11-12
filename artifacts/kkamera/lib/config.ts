const API_URL = process.env["EXPO_PUBLIC_API_URL"];
const PUBLIC_DOMAIN = process.env["EXPO_PUBLIC_DOMAIN"];

/**
 * Absolute base URL prepended to API requests.
 * - Local dev: EXPO_PUBLIC_API_URL (full URL, e.g. http://192.168.1.20:8080),
 *   set in artifacts/kkamera/.env.local. See .env.example.
 * - Replit dev: EXPO_PUBLIC_DOMAIN, set by the `dev` script to the dev host.
 * - Production (iOS/Android): the canonical app host, https://app.kkamera.app.
 */
export const API_BASE_URL: string = API_URL
  ? API_URL.replace(/\/+$/, "")
  : PUBLIC_DOMAIN
    ? `https://${PUBLIC_DOMAIN}`
    : "https://app.kkamera.app";

// A dev build with no API override talks to PRODUCTION (real accounts, real
// cloud uploads, real emails). Allowed, but never silently.
if (__DEV__ && !API_URL && !PUBLIC_DOMAIN) {
  console.warn(
    "\n!!! [KKamera] DEV BUILD IS USING THE PRODUCTION API (https://app.kkamera.app).\n" +
    "   Set EXPO_PUBLIC_API_URL in artifacts/kkamera/.env.local to a dev/local API to avoid touching production data.\n",
  );
}

/** Server-side cap on one uploaded file (multer `fileSize` in api-server routes/uploads.ts). */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** Recordings stop here, leaving headroom under MAX_UPLOAD_BYTES. */
export const MAX_RECORDING_BYTES = 190 * 1024 * 1024;
