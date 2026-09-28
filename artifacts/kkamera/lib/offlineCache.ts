// Last-known server state the camera needs to keep working offline: the user's
// upload destination and their subscription entitlement. Both are cached per
// user in AsyncStorage so a cold start without a network neither sprays
// captures to every account nor locks a paying/trial user out of the camera.
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { UploadTargetValue } from "@/lib/uploadTarget";

const TARGET_KEY = (userId: number) => `kkamera_upload_target_${userId}`;
const SUB_KEY = (userId: number) => `kkamera_sub_access_${userId}`;

export async function readCachedUploadTarget(userId: number | null | undefined): Promise<UploadTargetValue | null> {
  if (userId == null) return null;
  try {
    const raw = await AsyncStorage.getItem(TARGET_KEY(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UploadTargetValue;
    return typeof parsed?.mode === "string" ? parsed : null;
  } catch { return null; }
}

export async function writeCachedUploadTarget(userId: number | null | undefined, t: UploadTargetValue) {
  if (userId == null || !t?.mode) return;
  try {
    await AsyncStorage.setItem(TARGET_KEY(userId), JSON.stringify({
      mode: t.mode,
      connectionIds: t.connectionIds ?? [],
    }));
  } catch { /* best-effort */ }
}

// ── Subscription access ─────────────────────────────────────────────────────

export interface SubscriptionSnapshot {
  status: string;
  trialEnd?: string | null;
  currentPeriodEnd?: string | null;
}

export async function readCachedSubscription(userId: number | null | undefined): Promise<SubscriptionSnapshot | null> {
  if (userId == null) return null;
  try {
    const raw = await AsyncStorage.getItem(SUB_KEY(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SubscriptionSnapshot;
    return typeof parsed?.status === "string" ? parsed : null;
  } catch { return null; }
}

export async function writeCachedSubscription(userId: number | null | undefined, s: SubscriptionSnapshot | null) {
  if (userId == null) return;
  try {
    if (s) await AsyncStorage.setItem(SUB_KEY(userId), JSON.stringify(s));
    else await AsyncStorage.removeItem(SUB_KEY(userId));
  } catch { /* best-effort */ }
}

/** Matches the server's default PAST_DUE_GRACE_DAYS (api-server subscriptionAccess.ts). */
const PAST_DUE_GRACE_MS = 14 * 86_400_000;

function toTime(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Client mirror of the server's `evaluateAccess` rule
 * (artifacts/api-server/src/lib/subscriptionAccess.ts) so the camera gate and
 * the upload endpoint agree:
 *  - trial     → until trialEnd
 *  - active    → until currentPeriodEnd
 *  - cancelled → until the already-paid period (or trial) elapses
 *  - past_due  → until currentPeriodEnd + grace
 */
export function subscriptionAllows(s: SubscriptionSnapshot | null | undefined, now = Date.now()): boolean {
  if (!s) return false;
  const trialEnd = toTime(s.trialEnd);
  const periodEnd = toTime(s.currentPeriodEnd);
  switch (s.status) {
    case "trial":
      return trialEnd != null && trialEnd >= now;
    case "active":
      return periodEnd != null && periodEnd >= now;
    case "cancelled": {
      const until = periodEnd ?? trialEnd;
      return until != null && until > now;
    }
    case "past_due":
      return periodEnd != null && now <= periodEnd + PAST_DUE_GRACE_MS;
    default:
      return false;
  }
}
