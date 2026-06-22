import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Alert, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as LocalAuthentication from "expo-local-authentication";
import { useSettings } from "@/contexts/SettingsContext";
import { verifyPin, hashPin } from "@/lib/appLock";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

interface LockScreenProps {
  onUnlock: () => void;
  onLogout: () => void;
}

export default function LockScreen({ onUnlock, onLogout }: LockScreenProps) {
  const insets = useSafeAreaInsets();
  const { settings, updateSetting } = useSettings();
  const [pin, setPin] = useState("");
  const checkingRef = useRef(false);
  const [error, setError] = useState("");
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [, setNowTick] = useState(0);

  // Brute-force lockout: after 5 wrong PINs, lock the keypad with an escalating
  // delay (30s, then doubling, capped at 5 min).
  const FAIL_THRESHOLD = 5;
  const remainingLockMs = Math.max(0, lockedUntil - Date.now());
  const isLocked = remainingLockMs > 0;

  // Tick once a second while locked so the countdown updates and the keypad
  // re-enables when the lock expires.
  useEffect(() => {
    if (!isLocked) return;
    const id = setInterval(() => setNowTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [isLocked]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    LocalAuthentication.hasHardwareAsync().then(has => {
      if (has) LocalAuthentication.isEnrolledAsync().then(setBiometricAvailable);
    });
  }, []);

  const tryBiometric = useCallback(async () => {
    if (Platform.OS === "web") return;
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock KKamera",
        fallbackLabel: "Use PIN",
        cancelLabel: "Cancel",
        disableDeviceFallback: false,
      });
      if (result.success) {
        onUnlock();
      } else if (result.error !== "user_cancel") {
        setError("Biometric failed — enter your PIN");
      }
    } catch {
      setError("Biometric unavailable — enter your PIN");
    }
  }, [onUnlock]);

  // Try biometric on mount
  useEffect(() => {
    if (settings.appLockType === "biometric" && biometricAvailable) {
      tryBiometric();
    }
  }, [biometricAvailable]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePinDigit = (digit: string) => {
    // Ignore input while locked out, while a check is in flight, or when the PIN
    // is already complete (a fast extra tap mustn't append a 5th digit).
    if (isLocked || checkingRef.current || pin.length >= 4) return;
    const next = pin + digit;
    setPin(next);
    setError("");
    if (next.length === 4) {
      checkingRef.current = true;
      void verifyPin(next, settings.appPin)
        .then((ok) => {
          if (ok) {
            setAttempts(0);
            setLockedUntil(0);
            // Upgrade a legacy cleartext PIN to a salted hash on first unlock
            // (a stored hash is 64 hex chars; anything else is legacy cleartext).
            if (settings.appPin.length !== 64) {
              hashPin(next).then((h) => updateSetting("appPin", h)).catch(() => {});
            }
            onUnlock();
          } else {
            const n = attempts + 1;
            setAttempts(n);
            setPin("");
            if (n >= FAIL_THRESHOLD) {
              const lockMs = Math.min(5 * 60_000, 30_000 * 2 ** (n - FAIL_THRESHOLD));
              setLockedUntil(Date.now() + lockMs);
              setError(`Too many attempts. Locked for ${Math.ceil(lockMs / 1000)}s.`);
            } else {
              setError(`Incorrect PIN (${FAIL_THRESHOLD - n} left)`);
            }
          }
        })
        .finally(() => { checkingRef.current = false; });
    }
  };

  const handlePinDelete = () => setPin(p => p.slice(0, -1));

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.logoRow}>
        <Ionicons name="lock-closed" size={32} color={PRIMARY} />
        <Text style={styles.logoText}>KKamera</Text>
      </View>

      <Text style={styles.title}>Unlock</Text>

      {/* PIN dots */}
      <View style={styles.dotsRow}>
        {[0, 1, 2, 3].map(i => (
          <View key={i} style={[styles.dot, i < pin.length && styles.dotFilled]} />
        ))}
      </View>

      {isLocked ? (
        <Text style={styles.errorText}>Too many attempts. Try again in {Math.ceil(remainingLockMs / 1000)}s.</Text>
      ) : error ? (
        <Text style={styles.errorText}>{error}</Text>
      ) : (
        <Text style={styles.hint}>Enter your 4-digit PIN</Text>
      )}

      {/* Numpad */}
      <View style={styles.numpad}>
        {["1","2","3","4","5","6","7","8","9","",  "0","⌫"].map((key, i) => {
          if (key === "") return <View key={i} style={styles.numKey} />;
          return (
            <TouchableOpacity
              key={i}
              style={styles.numKey}
              onPress={() => key === "⌫" ? handlePinDelete() : handlePinDigit(key)}
              activeOpacity={0.6}
            >
              <Text style={styles.numKeyText}>{key}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Biometric button */}
      {settings.appLockType === "biometric" && biometricAvailable && Platform.OS !== "web" && (
        <TouchableOpacity style={styles.biometricBtn} onPress={tryBiometric}>
          <Ionicons name="finger-print-outline" size={28} color={PRIMARY} />
          <Text style={styles.biometricText}>Use Biometrics</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.logoutBtn} onPress={() => {
        Alert.alert("Sign Out", "Sign out of KKamera?", [
          { text: "Cancel", style: "cancel" },
          { text: "Sign Out", style: "destructive", onPress: onLogout },
        ]);
      }}>
        <Text style={styles.logoutText}>Sign Out</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: BG,
    alignItems: "center", justifyContent: "center",
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
  errorText: { fontSize: 13, color: "#ef4444", fontFamily: "Inter_500Medium", marginBottom: 32 },
  numpad: {
    flexDirection: "row", flexWrap: "wrap", width: 264, gap: 12, marginBottom: 32,
  },
  numKey: {
    width: 80, height: 64, borderRadius: 16,
    backgroundColor: CARD, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: "rgba(177,152,112,0.15)",
  },
  numKeyText: { fontSize: 24, fontFamily: "Inter_600SemiBold", color: "white" },
  biometricBtn: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 24 },
  biometricText: { fontSize: 15, color: PRIMARY, fontFamily: "Inter_500Medium" },
  logoutBtn: { marginTop: 8 },
  logoutText: { fontSize: 14, color: "#555", fontFamily: "Inter_400Regular" },
});
