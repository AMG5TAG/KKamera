import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// ---------------------------------------------------------------------------
// App-lock PIN storage
//
// The PIN is never persisted in cleartext. On native it lives in the OS keystore
// (expo-secure-store: iOS Keychain / Android Keystore-backed storage) as a
// SHA-256 hash with a random per-install salt. On web (not a shipping target)
// SecureStore is unavailable, so it falls back to AsyncStorage.
//
// NOTE: a 4-digit PIN is inherently low-entropy — the hash prevents casual
// disclosure; the real brute-force defence is the persisted attempt lockout
// below plus the OS keystore protecting the record at rest.
//
// Legacy: earlier builds stored the PIN (fixed-salt hash, or even cleartext) in
// the AsyncStorage-backed `settings.appPin`. `legacyPinStartupAction` runs at
// startup (app/_layout.tsx): once a v2 record exists the legacy value is simply
// dropped, and a cleartext legacy PIN is re-hashed into SecureStore right away.
// A fixed-salt legacy HASH can only be re-hashed with the PIN itself, so it stays
// until the next successful unlock, where `verifyPin` migrates it; callers then
// clear `settings.appPin`.
// ---------------------------------------------------------------------------

const PIN_KEY = "kkamera_app_pin_v2";
const ATTEMPTS_KEY = "kkamera_app_lock_attempts";
const LEGACY_PIN_SALT = "kkamera::app-lock::v1";
const PIN_PEPPER = "kkamera::app-lock::v2";

/**
 * How long the app must have been in the background before returning re-locks
 * it. Brief trips out (a permission dialog, the OAuth sheet, Control Center,
 * our own Face ID prompt — iOS reports those as `inactive`, not `background`)
 * never re-lock.
 */
export const RELOCK_GRACE_MS = 30_000;

/** Wrong PINs allowed before the keypad is locked out. */
export const PIN_FAIL_THRESHOLD = 5;
/**
 * Total wrong PINs (since the last successful unlock) after which the PIN is
 * erased and the user is signed out — only the account password gets back in.
 * This hard cap is the real brute-force bound: a lockout can be shortened by
 * changing the clock and killing the app, the cap can't.
 */
export const PIN_MAX_FAILURES = 10;
/** Lockout after the threshold: 30s, doubling per further failure, capped at 5 min. */
export function lockoutMsForFailures(failures: number): number {
  if (failures < PIN_FAIL_THRESHOLD) return 0;
  return Math.min(5 * 60_000, 30_000 * 2 ** (failures - PIN_FAIL_THRESHOLD));
}

/** Wrong PINs left before the sign-out at PIN_MAX_FAILURES. */
export function attemptsBeforeSignOut(failures: number): number {
  return Math.max(0, PIN_MAX_FAILURES - failures);
}

const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

async function secureGet(key: string): Promise<string | null> {
  try {
    if (Platform.OS === "web") return await AsyncStorage.getItem(key);
    return await SecureStore.getItemAsync(key, SECURE_OPTS);
  } catch {
    return null;
  }
}

async function secureSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    await AsyncStorage.setItem(key, value);
  } else {
    await SecureStore.setItemAsync(key, value, SECURE_OPTS);
  }
}

async function secureDelete(key: string): Promise<void> {
  try {
    if (Platform.OS === "web") await AsyncStorage.removeItem(key);
    else await SecureStore.deleteItemAsync(key, SECURE_OPTS);
  } catch {
    // best effort
  }
}

interface StoredPin {
  v: 2;
  salt: string;
  hash: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashWithSalt(pin: string, salt: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${PIN_PEPPER}:${salt}:${pin}`);
}

async function legacyHash(pin: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${LEGACY_PIN_SALT}:${pin}`);
}

/** Constant-time-ish string compare (both inputs are fixed-length hex digests). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readStoredPin(): Promise<StoredPin | null> {
  const raw = await secureGet(PIN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredPin;
    if (parsed && parsed.v === 2 && parsed.salt && parsed.hash) return parsed;
  } catch { /* corrupt record → treat as absent */ }
  return null;
}

/** Hash and store a new PIN (replacing any previous one) and reset the attempt counter. */
export async function savePin(pin: string): Promise<void> {
  const salt = toHex(await Crypto.getRandomBytesAsync(16));
  const record: StoredPin = { v: 2, salt, hash: await hashWithSalt(pin, salt) };
  await secureSet(PIN_KEY, JSON.stringify(record));
  await resetPinFailures();
}

/** Remove the stored PIN and attempt counter (used by Panic Wipe). */
export async function clearPin(): Promise<void> {
  monoLock = null;
  await secureDelete(PIN_KEY);
  await secureDelete(ATTEMPTS_KEY);
}

/**
 * Startup clean-up of the legacy `settings.appPin` value. Returns true when the
 * caller should clear it: a v2 record already exists (the legacy copy is dead
 * weight), or the legacy value was cleartext and has just been re-hashed into
 * SecureStore. A legacy fixed-salt hash with no v2 record returns false — it is
 * still the only credential and is migrated on the next successful unlock.
 */
export async function legacyPinStartupAction(legacyStored: string | undefined): Promise<boolean> {
  if (!legacyStored) return false;
  if (await readStoredPin()) return true;
  if (/^\d{4}$/.test(legacyStored)) {
    try {
      await savePin(legacyStored);
      return true;
    } catch {
      return false; // keystore unavailable — keep it, retry next launch
    }
  }
  return false;
}

/**
 * Whether a PIN exists — in SecureStore, or as a not-yet-migrated legacy value
 * from `settings.appPin`.
 */
export async function hasPin(legacyStored?: string): Promise<boolean> {
  if (await readStoredPin()) return true;
  return !!legacyStored;
}

export interface VerifyResult {
  ok: boolean;
  /** True when a legacy `settings.appPin` value was verified and migrated to SecureStore — clear the legacy field. */
  migratedLegacy: boolean;
}

/**
 * Verify an entered PIN against SecureStore, falling back to the legacy
 * `settings.appPin` value (fixed-salt hash or cleartext). A legacy match is
 * re-saved in the new format.
 */
export async function verifyPin(entered: string, legacyStored?: string): Promise<VerifyResult> {
  const stored = await readStoredPin();
  if (stored) {
    return { ok: safeEqual(await hashWithSalt(entered, stored.salt), stored.hash), migratedLegacy: false };
  }
  if (!legacyStored) return { ok: false, migratedLegacy: false };
  const legacyOk = safeEqual(await legacyHash(entered), legacyStored) || entered === legacyStored;
  if (!legacyOk) return { ok: false, migratedLegacy: false };
  try {
    await savePin(entered);
    return { ok: true, migratedLegacy: true };
  } catch {
    // Couldn't migrate (keystore unavailable) — still unlock; retry next time.
    return { ok: true, migratedLegacy: false };
  }
}

// ---------------------------------------------------------------------------
// Failed-attempt counter — persisted so killing/remounting the lock screen
// doesn't reset the brute-force lockout.
//
// Clock changes: the record keeps the wall-clock time the lockout started. A
// clock that has moved BACKWARDS since then (now < lockedAt) is treated as still
// locked for the full period, measured from now. While the app stays alive the
// lockout is also tracked on the monotonic clock (performance.now), so moving
// the clock forward doesn't end it early either. A forward change plus an app
// kill can still shorten a lockout — the PIN_MAX_FAILURES cap bounds that.
// ---------------------------------------------------------------------------

export interface PinFailureState {
  failures: number;
  /** Wall-clock time the current lockout ends (0 = not locked out). */
  lockedUntil: number;
  /** True once PIN_MAX_FAILURES is reached: the PIN has been erased and the caller must sign out. */
  exhausted?: boolean;
}

interface StoredAttempts {
  failures: number;
  /** Wall-clock start of the current lockout. */
  lockedAt: number;
  /** Length of the current lockout. */
  lockMs: number;
}

/** In-process monotonic copy of the current lockout. */
let monoLock: { start: number; ms: number } | null = null;

function monoNow(): number {
  try {
    const p = (globalThis as { performance?: { now?: () => number } }).performance;
    if (p?.now) return p.now();
  } catch { /* fall through */ }
  return Date.now();
}

async function readAttempts(): Promise<StoredAttempts> {
  const raw = await secureGet(ATTEMPTS_KEY);
  if (!raw) return { failures: 0, lockedAt: 0, lockMs: 0 };
  try {
    const p = JSON.parse(raw) as Partial<StoredAttempts> & { lockedUntil?: number };
    const failures = Number(p.failures) || 0;
    if (p.lockedAt != null) {
      return { failures, lockedAt: Number(p.lockedAt) || 0, lockMs: Number(p.lockMs) || 0 };
    }
    // Older record ({failures, lockedUntil}): re-derive a full lockout from now.
    const lockMs = lockoutMsForFailures(failures);
    return { failures, lockedAt: lockMs && Number(p.lockedUntil) > Date.now() ? Date.now() : 0, lockMs };
  } catch {
    return { failures: 0, lockedAt: 0, lockMs: 0 };
  }
}

async function writeAttempts(a: StoredAttempts): Promise<void> {
  try { await secureSet(ATTEMPTS_KEY, JSON.stringify(a)); } catch { /* best effort */ }
}

export async function getPinFailures(): Promise<PinFailureState> {
  const a = await readAttempts();
  if (!a.lockMs || !a.lockedAt) {
    return { failures: a.failures, lockedUntil: 0, exhausted: a.failures >= PIN_MAX_FAILURES };
  }
  const now = Date.now();
  let lockedUntil = a.lockedAt + a.lockMs;
  if (now < a.lockedAt) {
    // The clock went backwards: restart the full lockout from now, and persist
    // that so repeating the trick never helps.
    lockedUntil = now + a.lockMs;
    await writeAttempts({ ...a, lockedAt: now });
  }
  if (monoLock) {
    const monoRemaining = monoLock.start + monoLock.ms - monoNow();
    if (monoRemaining > 0) lockedUntil = Math.max(lockedUntil, now + monoRemaining);
  }
  return { failures: a.failures, lockedUntil: lockedUntil > now ? lockedUntil : 0, exhausted: a.failures >= PIN_MAX_FAILURES };
}

/**
 * Record a wrong PIN; returns the new state (with lockedUntil set once over the
 * threshold). At PIN_MAX_FAILURES the PIN is erased and `exhausted` is set —
 * the caller must sign out.
 */
export async function recordPinFailure(): Promise<PinFailureState> {
  const prev = await readAttempts();
  const failures = prev.failures + 1;
  if (failures >= PIN_MAX_FAILURES) {
    monoLock = null;
    await secureDelete(PIN_KEY);
    await writeAttempts({ failures, lockedAt: 0, lockMs: 0 });
    return { failures, lockedUntil: 0, exhausted: true };
  }
  const lockMs = lockoutMsForFailures(failures);
  const now = Date.now();
  monoLock = lockMs ? { start: monoNow(), ms: lockMs } : null;
  await writeAttempts({ failures, lockedAt: lockMs ? now : 0, lockMs });
  return { failures, lockedUntil: lockMs ? now + lockMs : 0, exhausted: false };
}

export async function resetPinFailures(): Promise<void> {
  monoLock = null;
  await secureDelete(ATTEMPTS_KEY);
}

// ---------------------------------------------------------------------------
// Device authentication (biometrics / device passcode)
// ---------------------------------------------------------------------------

// Lazy-load expo-local-authentication so the module (and its native-only
// dependency `invariant`) is never bundled/evaluated on web.
async function getLocalAuth() {
  return import("expo-local-authentication");
}

/**
 * Whether the device can satisfy a biometric/device-credential prompt: enrolled
 * biometrics, or at least a device passcode (the prompt falls back to it).
 */
export async function isDeviceAuthAvailable(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    const LocalAuthentication = await getLocalAuth();
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    return level > LocalAuthentication.SecurityLevel.NONE;
  } catch {
    return false;
  }
}

/** Whether biometrics specifically (Face ID / Touch ID / fingerprint) are enrolled. */
export async function isBiometricEnrolled(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    const LocalAuthentication = await getLocalAuth();
    return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
  } catch {
    return false;
  }
}

// iOS reports the app as `inactive` while the Face ID sheet is up, and Android's
// device-credential screen is a separate activity (the app goes `background`).
// The lock gate consults this so our own prompt never counts as "left the app".
let authPromptDepth = 0;
let lastAuthPromptEndedAt = 0;

/** True while (or within a moment after) a device-auth prompt we started is showing. */
export function isAuthPromptActive(): boolean {
  return authPromptDepth > 0 || Date.now() - lastAuthPromptEndedAt < 1500;
}

export type DeviceAuthResult = "success" | "cancel" | "failed" | "unavailable";

export async function authenticateWithDevice(promptMessage: string): Promise<DeviceAuthResult> {
  if (Platform.OS === "web") return "unavailable";
  authPromptDepth++;
  try {
    const LocalAuthentication = await getLocalAuth();
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel: "Cancel",
      disableDeviceFallback: false,
    });
    if (result.success) return "success";
    if (result.error === "user_cancel" || result.error === "system_cancel" || result.error === "app_cancel") {
      return "cancel";
    }
    if (result.error === "not_enrolled" || result.error === "not_available" || result.error === "passcode_not_set") {
      return "unavailable";
    }
    return "failed";
  } catch {
    return "unavailable";
  } finally {
    authPromptDepth--;
    lastAuthPromptEndedAt = Date.now();
  }
}
