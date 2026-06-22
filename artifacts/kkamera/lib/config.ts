import { Platform } from "react-native";

const PUBLIC_DOMAIN = process.env["EXPO_PUBLIC_DOMAIN"];

/**
 * Absolute base URL prepended to API requests.
 * - Dev: EXPO_PUBLIC_DOMAIN, set by the `dev` script to the local server.
 * - Production web: "" — the API server serves the web app same-origin, so
 *   relative `/api/...` requests resolve correctly.
 * - Production native (iOS/Android): the canonical app host, https://kkamera.app.
 *
 * The Replit preview domain is never used as the app's public API host.
 */
export const API_BASE_URL: string = PUBLIC_DOMAIN
  ? `https://${PUBLIC_DOMAIN}`
  : Platform.OS === "web"
    ? ""
    : "https://kkamera.app";
