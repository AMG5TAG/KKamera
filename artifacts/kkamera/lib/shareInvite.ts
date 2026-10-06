import { Platform, Share } from "react-native";

/**
 * Sharing the user's referral code to the OS share sheet (Messages, WhatsApp,
 * Mail, social apps…).
 *
 * Web needs care: react-native-web's Share.share *rejects* with "Share is not
 * supported in this browser" whenever `navigator.share` is absent, which is
 * most desktop browsers. Left unhandled that makes the tap do nothing at all,
 * so we fall back to copying the invite to the clipboard.
 */

const SHARE_TITLE = "Try KKamera — no-trace camera";

/** Public signup URL that credits the referral. */
export function inviteLink(code: string): string {
  return `https://app.kkamera.app/auth/register?ref=${encodeURIComponent(code.trim())}`;
}

export function inviteMessage(code: string): string {
  const trimmed = code.trim();
  return (
    "Join me on KKamera — the privacy-first camera app that uploads photos & " +
    "videos straight to your own cloud storage.\n\n" +
    `Sign up with my invite for a free 24-hour trial:\n${inviteLink(trimmed)}\n\n` +
    `Or use code: ${trimmed}`
  );
}

export type ShareInviteResult =
  /** The OS share sheet opened and the user picked a target. */
  | "shared"
  /** The share sheet opened and the user dismissed it. */
  | "dismissed"
  /** No share sheet available; the invite went to the clipboard instead. */
  | "copied"
  /** Nothing worked — the caller should surface the code for manual copying. */
  | "unavailable";

async function copyToClipboard(text: string): Promise<boolean> {
  if (Platform.OS !== "web") return false;
  try {
    const nav: any = (globalThis as any).navigator;
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch { /* clipboard blocked (insecure origin / permission) */ }
  return false;
}

/**
 * Open the platform share sheet for `code`, degrading to the clipboard when no
 * share sheet exists. Never throws — returns what actually happened so the
 * caller can tell the user.
 */
export async function shareInvite(code: string | null | undefined): Promise<ShareInviteResult> {
  const trimmed = code?.trim();
  if (!trimmed) return "unavailable";

  const message = inviteMessage(trimmed);
  try {
    const result = await Share.share(
      {
        message,
        title: SHARE_TITLE,
        // Android's share intent ignores `url` and sends `message` only, so
        // adding it there would drop the link on some targets. iOS and the Web
        // Share API both use it to build a richer preview.
        ...(Platform.OS === "android" ? {} : { url: inviteLink(trimmed) }),
      },
      { dialogTitle: SHARE_TITLE, subject: SHARE_TITLE },
    );
    // react-native-web resolves undefined (navigator.share has no result).
    if ((result as any)?.action === Share.dismissedAction) return "dismissed";
    return "shared";
  } catch {
    return (await copyToClipboard(message)) ? "copied" : "unavailable";
  }
}
