import * as Crypto from "expo-crypto";

// The app-lock PIN must never be persisted in cleartext (on web, AsyncStorage is
// localStorage and trivially readable). We store and compare a salted SHA-256
// hash instead. NOTE: a short numeric PIN is inherently low-entropy — this
// prevents casual plaintext disclosure, it is not a defence against an attacker
// who can run code with the stored hash.
const PIN_SALT = "kkamera::app-lock::v1";

export async function hashPin(pin: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${PIN_SALT}:${pin}`);
}

/**
 * Returns true if `entered` matches the stored value. Accepts a legacy
 * cleartext match as a fallback so PINs set before hashing still unlock (the
 * caller should re-store the hashed value on success).
 */
export async function verifyPin(entered: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  if ((await hashPin(entered)) === stored) return true;
  return entered === stored; // legacy cleartext PIN
}
