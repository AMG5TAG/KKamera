import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Alert, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as LocalAuthentication from "expo-local-authentication";
import { useSettings } from "@/contexts/SettingsContext";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

interface LockScreenProps {
  onUnlock: () => void;
  onLogout: () => void;
}

export default function LockScreen({ onUnlock, onLogout }: LockScreenProps) {
  const insets = useSafeAreaInsets();
  const { settings } = useSettings();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [biometricAvailable, setBiometricAvailable] = useState(false);

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
    const next = pin + digit;
    setPin(next);
    setError("");
    if (next.length === 4) {
      if (next === settings.appPin) {
        onUnlock();
      } else {
        setError("Incorrect PIN");
        setPin("");
      }
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

      {error ? (
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
