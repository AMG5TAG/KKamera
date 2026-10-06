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

