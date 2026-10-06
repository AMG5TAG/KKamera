// Store / app-launch config shared by every page. Keep in step with
// artifacts/kkamera/app.json (scheme "kkamera", bundle/package id "app.kkamera").

export const APP_SCHEME = "kkamera://";
// TODO: replace with the real App Store id once the iOS app is published
// (same value as ascAppId in artifacts/kkamera/eas.json).
export const IOS_STORE_URL = "https://apps.apple.com/app/kkamera/id0000000000";
export const ANDROID_STORE_URL =
  "https://play.google.com/store/apps/details?id=app.kkamera";

export const CONTACT_EMAIL = "development@koastal.com.au";
export const COMPANY_URL = "https://www.koastal.com.au";

export type MobileOS = "ios" | "android" | "other";

export function detectMobileOS(): MobileOS {
  const ua = navigator.userAgent || "";
  // iPadOS reports as "MacIntel" but exposes touch points.
  const isIpadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/i.test(ua) || isIpadOS) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

export function storeUrlFor(os: MobileOS): string | null {
  return os === "ios" ? IOS_STORE_URL : os === "android" ? ANDROID_STORE_URL : null;
}

/**
 * Try to open the installed app at `appPath` (e.g. "auth/register?ref=ABC");
 * if nothing takes over within ~1.2 s, go to `fallbackUrl` instead.
 */
export function openApp(appPath: string, fallbackUrl: string | null): void {
  if (fallbackUrl) {
    const fallback = window.setTimeout(() => {
      window.location.href = fallbackUrl;
    }, 1200);
    // If the app opens, the tab is backgrounded — cancel the store fallback.
    document.addEventListener(
      "visibilitychange",
      () => { if (document.hidden) window.clearTimeout(fallback); },
      { once: true },
    );
  }
  window.location.href = APP_SCHEME + appPath;
}
