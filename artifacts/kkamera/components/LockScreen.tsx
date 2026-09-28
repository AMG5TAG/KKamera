import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Platform, ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useSettings } from "@/contexts/SettingsContext";
import {
  authenticateWithDevice, getPinFailures, hasPin, isDeviceAuthAvailable,
  recordPinFailure, resetPinFailures, verifyPin, PIN_FAIL_THRESHOLD,
} from "@/lib/appLock";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

export type LockSignOutReason = "user" | "no-credential";

interface LockScreenProps {
  onUnlock: () => void;
  /** Sign out and go to the password login (a successful login unlocks the app). */
  onSignOut: (reason: LockSignOutReason) => void;
}

// Not a route: this lives in components/ so `kkamera://lock` can't deep-link to
// it. Rendered by the app-lock gate in app/_layout.tsx above the navigator.
export default function LockScreen({ onUnlock, onSignOut }: LockScreenProps) {
  const insets = useSafeAreaInsets();
  const { settings, updateSetting } = useSettings();
  const [pin, setPin] = useState("");
  const checkingRef = useRef(false);
  const [error, setError] = useState("");
  const [pinAvailable, setPinAvailable] = useState<boolean | null>(null);
  const [deviceAuth, setDeviceAuth] = useState<boolean | null>(null);
  const [failures, setFailures] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [, setNowTick] = useState(0);

  const remainingLockMs = Math.max(0, lockedUntil - Date.now());
  const isLockedOut = remainingLockMs > 0;

  // Load what can unlock this device, and the persisted brute-force state.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [p, d, f] = await Promise.all([
        hasPin(settings.appPin),
        isDeviceAuthAvailable(),
        getPinFailures(),
      ]);
      if (cancelled) return;
      setPinAvailable(p);
      setDeviceAuth(d);
      setFailures(f.failures);
      setLockedUntil(f.lockedUntil);
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Tick once a second while locked out so the countdown updates and the keypad
  // re-enables when the lockout expires.
  useEffect(() => {
    if (!isLockedOut) return;
    const id = setInterval(() => setNowTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [isLockedOut]);

  const loaded = pinAvailable !== null && deviceAuth !== null;
  // PIN keypad: shown whenever a PIN exists (for the biometric type it is the fallback).
  const showKeypad = !!pinAvailable;
  // Device auth: the chosen method for "biometric", and the fallback when "pin"
  // was selected but no PIN is stored.
  const showDeviceAuth = !!deviceAuth && (settings.appLockType === "biometric" || !pinAvailable);
  const noCredential = loaded && !showKeypad && !showDeviceAuth;

  const tryDeviceAuth = useCallback(async () => {
    const result = await authenticateWithDevice("Unlock KKamera");
    if (result === "success") {
      await resetPinFailures();
      onUnlock();
    } else if (result === "failed") {
      setError(pinAvailable ? "Not recognised — enter your PIN" : "Not recognised — try again");
    } else if (result === "unavailable") {
      setDeviceAuth(false);
    }
  }, [onUnlock, pinAvailable]);

  // Prompt automatically once, when device auth is the primary method.
  const autoPromptedRef = useRef(false);
  useEffect(() => {
    if (!loaded || autoPromptedRef.current) return;
    if (showDeviceAuth && (settings.appLockType === "biometric" || !pinAvailable)) {
      autoPromptedRef.current = true;
      void tryDeviceAuth();
    }
  }, [loaded, showDeviceAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePinDigit = (digit: string) => {
    // Ignore input while locked out, while a check is in flight, or when the PIN
    // is already complete (a fast extra tap mustn't append a 5th digit).
    if (isLockedOut || checkingRef.current || pin.length >= 4) return;
    const next = pin + digit;
    setPin(next);
    setError("");
    if (next.length !== 4) return;
    checkingRef.current = true;
    void (async () => {
      try {
        // Re-read the persisted lockout so a remount can't bypass it.
        const current = await getPinFailures();
        if (current.lockedUntil > Date.now()) {
          setFailures(current.failures);
          setLockedUntil(current.lockedUntil);
          setPin("");
          return;
        }
        const { ok, migratedLegacy } = await verifyPin(next, settings.appPin);
        if (ok) {
          await resetPinFailures();
          // The PIN now lives (hashed, salted) in SecureStore — drop the legacy copy.
          if (migratedLegacy) updateSetting("appPin", "");
          onUnlock();
          return;
        }
        const state = await recordPinFailure();
        setFailures(state.failures);
        setLockedUntil(state.lockedUntil);
        setPin("");
        if (state.lockedUntil > Date.now()) {
          setError("");
        } else {
          setError(`Incorrect PIN (${Math.max(0, PIN_FAIL_THRESHOLD - state.failures)} left)`);
        }
      } finally {
        checkingRef.current = false;
      }
    })();
  };

  const handlePinDelete = () => setPin(p => p.slice(0, -1));

  const confirmSignOut = () => {
    Alert.alert("Sign Out", "Sign out of KKamera? You can sign back in with your password.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: () => onSignOut("user") },
    ]);
  };

  if (!loaded) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <ActivityIndicator color={PRIMARY} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.logoRow}>
        <Ionicons name="lock-closed" size={32} color={PRIMARY} />
        <Text style={styles.logoText}>KKamera</Text>
      </View>

      <Text style={styles.title}>Unlock</Text>

      {noCredential ? (
        <>
          <Text style={[styles.hint, styles.centerText]}>
            No PIN or device unlock is set up for this app lock. Sign in with your password to continue.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => onSignOut("no-credential")}>
            <Text style={styles.primaryBtnText}>Sign in with password</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          {showKeypad && (
            <>
              <View style={styles.dotsRow}>
                {[0, 1, 2, 3].map(i => (
                  <View key={i} style={[styles.dot, i < pin.length && styles.dotFilled]} />
                ))}
              </View>

              {isLockedOut ? (
                <Text style={styles.errorText}>Too many attempts. Try again in {Math.ceil(remainingLockMs / 1000)}s.</Text>
              ) : error ? (
                <Text style={styles.errorText}>{error}</Text>
              ) : (
                <Text style={styles.hint}>
                  {failures > 0 ? `Enter your 4-digit PIN (${Math.max(0, PIN_FAIL_THRESHOLD - failures)} tries before a pause)` : "Enter your 4-digit PIN"}
                </Text>
              )}

              <View style={styles.numpad}>
                {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((key, i) => {
                  if (key === "") return <View key={i} style={styles.numKey} />;
                  return (
                    <TouchableOpacity
                      key={i}
                      style={[styles.numKey, isLockedOut && styles.numKeyDisabled]}
                      onPress={() => key === "⌫" ? handlePinDelete() : handlePinDigit(key)}
                      disabled={isLockedOut}
                      activeOpacity={0.6}
                      accessibilityLabel={key === "⌫" ? "Delete" : key}
                    >
                      <Text style={styles.numKeyText}>{key}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}

          {!showKeypad && error ? <Text style={styles.errorText}>{error}</Text> : null}

          {showDeviceAuth && Platform.OS !== "web" && (
            <TouchableOpacity style={styles.biometricBtn} onPress={() => void tryDeviceAuth()}>
              <Ionicons name={Platform.OS === "ios" ? "scan-outline" : "finger-print-outline"} size={28} color={PRIMARY} />
              <Text style={styles.biometricText}>{Platform.OS === "ios" ? "Use Face ID / Passcode" : "Use Biometrics"}</Text>
            </TouchableOpacity>
          )}
        </>
      )}

      <TouchableOpacity style={styles.logoutBtn} onPress={confirmSignOut}>
        <Text style={styles.logoutText}>{showKeypad ? "Forgot PIN? Sign out" : "Sign Out"}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: BG,
    alignItems: "center", justifyContent: "center", paddingHorizontal: 28,
  },
  logoRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 40 },
  logoText: { fontSize: 22, fontFamily: "Inter_700Bold", color: "white" },
  title: { fontSize: 18, fontFamily: "Inter_600SemiBold", color: "white", marginBottom: 24 },
  dotsRow: { flexDirection: "row", gap: 16, marginBottom: 12 },
  dot: {
    width: 16, height: 16, borderRadius: 8,
    borderWidth: 2, borderColor: "#555",
  },
  dotFilled: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  hint: { fontSize: 13, color: "#666", fontFamily: "Inter_400Regular", marginBottom: 32 },
  centerText: { textAlign: "center", lineHeight: 19, color: "#999" },
  errorText: { fontSize: 13, color: "#ef4444", fontFamily: "Inter_500Medium", marginBottom: 32, textAlign: "center" },
  numpad: {
    flexDirection: "row", flexWrap: "wrap", width: 264, gap: 12, marginBottom: 32,
  },
  numKey: {
    width: 80, height: 64, borderRadius: 16,
    backgroundColor: CARD, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: "rgba(177,152,112,0.15)",
  },
  numKeyDisabled: { opacity: 0.4 },
  numKeyText: { fontSize: 24, fontFamily: "Inter_600SemiBold", color: "white" },
  biometricBtn: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 24 },
  biometricText: { fontSize: 15, color: PRIMARY, fontFamily: "Inter_500Medium" },
  primaryBtn: { backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 15, paddingHorizontal: 28, marginBottom: 24 },
  primaryBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
  logoutBtn: { marginTop: 8, padding: 8 },
  logoutText: { fontSize: 14, color: "#777", fontFamily: "Inter_400Regular" },
});
