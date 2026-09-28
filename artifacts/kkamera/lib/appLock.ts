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
// the AsyncStorage-backed `settings.appPin`. `verifyPin` still accepts that value
// and transparently migrates it into SecureStore on the first successful unlock;
// callers should then clear `settings.appPin`.
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
/** Lockout after the threshold: 30s, doubling per further failure, capped at 5 min. */
export function lockoutMsForFailures(failures: number): number {
  if (failures < PIN_FAIL_THRESHOLD) return 0;
  return Math.min(5 * 60_000, 30_000 * 2 ** (failures - PIN_FAIL_THRESHOLD));
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
  await secureDelete(PIN_KEY);
  await secureDelete(ATTEMPTS_KEY);
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
// ---------------------------------------------------------------------------

export interface PinFailureState {
  failures: number;
  lockedUntil: number;
}

export async function getPinFailures(): Promise<PinFailureState> {
  const raw = await secureGet(ATTEMPTS_KEY);
  if (!raw) return { failures: 0, lockedUntil: 0 };
  try {
    const p = JSON.parse(raw) as Partial<PinFailureState>;
    return { failures: Number(p.failures) || 0, lockedUntil: Number(p.lockedUntil) || 0 };
  } catch {
    return { failures: 0, lockedUntil: 0 };
  }
}

/** Record a wrong PIN; returns the new state (with lockedUntil set once over the threshold). */
export async function recordPinFailure(): Promise<PinFailureState> {
  const prev = await getPinFailures();
  const failures = prev.failures + 1;
  const lockMs = lockoutMsForFailures(failures);
  const next = { failures, lockedUntil: lockMs ? Date.now() + lockMs : 0 };
  try { await secureSet(ATTEMPTS_KEY, JSON.stringify(next)); } catch { /* best effort */ }
  return next;
}

export async function resetPinFailures(): Promise<void> {
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
