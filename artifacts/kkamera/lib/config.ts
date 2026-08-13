const PUBLIC_DOMAIN = process.env["EXPO_PUBLIC_DOMAIN"];

/**
 * Absolute base URL prepended to API requests.
 * - Dev: EXPO_PUBLIC_DOMAIN, set by the `dev` script to the local server.
 * - Production (iOS/Android): the canonical app host, https://app.kkamera.app.
 */
export const API_BASE_URL: string = PUBLIC_DOMAIN
  ? `https://${PUBLIC_DOMAIN}`
  : "https://app.kkamera.app";
