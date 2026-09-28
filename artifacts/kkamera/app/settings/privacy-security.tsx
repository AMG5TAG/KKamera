import React, { useState, useEffect } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Switch, TextInput, Alert, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSettings } from "@/contexts/SettingsContext";
import { useAuth } from "@/contexts/AuthContext";
import { useUpload } from "@/contexts/UploadContext";
import {
  authenticateWithDevice, clearPin, hasPin, isBiometricEnrolled, isDeviceAuthAvailable, savePin, RELOCK_GRACE_MS,
} from "@/lib/appLock";
import { API_BASE_URL } from "@/lib/config";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";
const BORDER = "rgba(255,255,255,0.06)";
const DANGER = "#ef4444";

export default function PrivacySecurityScreen() {
  const insets = useSafeAreaInsets();
  const { settings, updateSetting, resetSettings } = useSettings();
  const { logout, token } = useAuth();
  const { discardQueue } = useUpload();
  const [deviceAuthAvailable, setDeviceAuthAvailable] = useState(false);
  const [biometricEnrolled, setBiometricEnrolled] = useState(false);
  const [pinStored, setPinStored] = useState(false);
  const [pinEntry, setPinEntry] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [pinStep, setPinStep] = useState<"idle" | "enter" | "confirm">("idle");
  const [savingPin, setSavingPin] = useState(false);

  useEffect(() => {
    void (async () => {
      const [device, bio, stored] = await Promise.all([
        isDeviceAuthAvailable(),
        isBiometricEnrolled(),
        hasPin(settings.appPin),
      ]);
      setDeviceAuthAvailable(device);
      setBiometricEnrolled(bio);
      setPinStored(stored);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const cancelPinSetup = () => {
    setPinEntry(""); setConfirmPin(""); setPinStep("idle");
  };

  // Choosing biometric only takes effect after a successful prompt, so the lock
  // can never be switched to a method this device can't satisfy.
  const enableDeviceLock = async () => {
    const result = await authenticateWithDevice("Confirm to use Face ID / Touch ID for KKamera");
    if (result === "success") {
      updateSetting("appLockType", "biometric");
      updateSetting("appLockEnabled", true);
      cancelPinSetup();
    } else if (result === "unavailable") {
      setDeviceAuthAvailable(false);
      Alert.alert("Not available", "Biometric unlock isn't set up on this device. Set a PIN instead.");
    }
  };

  const handleToggleLock = (v: boolean) => {
    if (!v) {
      updateSetting("appLockEnabled", false);
      cancelPinSetup();
      return;
    }
    if (settings.appLockType === "pin" && pinStored) {
      updateSetting("appLockEnabled", true);
    } else if (deviceAuthAvailable) {
      void enableDeviceLock();
    } else {
      // Nothing is enabled until a PIN has been entered, confirmed and saved.
      setPinStep("enter");
    }
  };

  const handleSelectPin = () => {
    if (pinStored && settings.appLockType !== "pin") {
      updateSetting("appLockType", "pin");
      return;
    }
    // No PIN yet (or re-tapping to change it): collect one first. The lock type
    // only switches to "pin" once the new PIN is confirmed and saved.
    setPinEntry(""); setConfirmPin(""); setPinStep("enter");
  };

  const handlePinSubmit = async () => {
    const value = pinStep === "enter" ? pinEntry : confirmPin;
    if (!/^\d{4}$/.test(value)) {
      Alert.alert("Invalid PIN", "PIN must be exactly 4 digits.");
      return;
    }
    if (pinStep === "enter") {
      setPinStep("confirm");
      return;
    }
    if (pinEntry !== confirmPin) {
      Alert.alert("PINs don't match", "Try again.");
      setPinEntry(""); setConfirmPin(""); setPinStep("enter");
      return;
    }
    setSavingPin(true);
    try {
      // Stored as a salted hash in the OS keystore, never in cleartext.
      await savePin(pinEntry);
    } catch {
      Alert.alert("Couldn't save PIN", "Your PIN could not be stored securely on this device. App lock was not changed.");
      return;
    } finally {
      setSavingPin(false);
    }
    // Drop any legacy copy kept in the (AsyncStorage-backed) settings.
    if (settings.appPin) updateSetting("appPin", "");
    setPinStored(true);
    updateSetting("appLockType", "pin");
    updateSetting("appLockEnabled", true);
    cancelPinSetup();
  };

  const handlePanic = () => {
    Alert.alert(
      "Panic Wipe",
      "This will immediately:\n\n• Disconnect all cloud accounts\n• Clear all upload history\n• Sign you out\n• Reset all settings\n\nThis cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Wipe Everything",
          style: "destructive",
          onPress: async () => {
            try {
              // Use the in-memory auth token from context. Reading it from
              // AsyncStorage broke on native, where the token lives in SecureStore
              // — so the server-side wipe silently no-op'd on the exact platforms
              // we ship. API_BASE_URL is "" on web (same-origin), a valid prefix.
              if (token) {
                await Promise.allSettled([
                  fetch(`${API_BASE_URL}/api/cloud-connections`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }),
                  fetch(`${API_BASE_URL}/api/uploads`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }),
                ]);
              }
            } catch { /* best effort */ }
            // Reset all local settings (clears the app-lock PIN too), as the
            // confirmation dialog promises, then sign out.
            await resetSettings();
            await clearPin();
            setPinStored(false);
            await discardQueue();
            await logout();
          },
        },
      ]
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={24} color={PRIMARY} />
      </TouchableOpacity>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.pageTitle}>Privacy & Security</Text>

        {/* App Lock */}
        <Text style={styles.sectionLabel}>App Lock</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.iconWrap}>
              <Ionicons name="lock-closed-outline" size={19} color={PRIMARY} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>Require unlock on open</Text>
              <Text style={styles.rowHint}>Biometric or PIN · re-locks after {RELOCK_GRACE_MS / 1000}s in the background</Text>
            </View>
            <Switch
              value={settings.appLockEnabled}
              onValueChange={handleToggleLock}
              trackColor={{ false: "#2a2720", true: PRIMARY }}
              thumbColor="white"
              ios_backgroundColor="#2a2720"
            />
          </View>

          {settings.appLockEnabled && (
            <>
              <View style={styles.divider} />
              {deviceAuthAvailable && Platform.OS !== "web" && (
                <>
                  <TouchableOpacity
                    style={styles.row}
                    onPress={() => { if (settings.appLockType !== "biometric") void enableDeviceLock(); }}
                  >
                    <View style={styles.iconWrap}>
                      <Ionicons name="finger-print-outline" size={19} color={PRIMARY} />
                    </View>
                    <View style={styles.rowBody}>
                      <Text style={styles.rowLabel}>
                        {biometricEnrolled ? "Biometric (Face/Touch ID)" : "Device passcode"}
                      </Text>
                      {pinStored && <Text style={styles.rowHint}>Your PIN also works as a fallback</Text>}
                    </View>
                    {settings.appLockType === "biometric" && (
                      <Ionicons name="checkmark-circle" size={20} color={PRIMARY} />
                    )}
                  </TouchableOpacity>
                  <View style={styles.divider} />
                </>
              )}
              <TouchableOpacity style={styles.row} onPress={handleSelectPin}>
                <View style={styles.iconWrap}>
                  <Ionicons name="keypad-outline" size={19} color={PRIMARY} />
                </View>
                <View style={styles.rowBody}>
                  <Text style={styles.rowLabel}>PIN Code</Text>
                  <Text style={styles.rowHint}>
                    {pinStored ? (settings.appLockType === "pin" ? "PIN set · tap to change" : "PIN set") : "Not set · tap to create"}
                  </Text>
                </View>
                {settings.appLockType === "pin" && pinStored && (
                  <Ionicons name="checkmark-circle" size={20} color={PRIMARY} />
                )}
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* PIN setup */}
        {pinStep !== "idle" && (
          <View style={[styles.card, { marginTop: 12 }]}>
            <View style={{ padding: 16 }}>
              <Text style={styles.pinLabel}>
                {pinStep === "enter" ? "Enter a 4-digit PIN" : "Confirm your PIN"}
              </Text>
              <TextInput
                key={pinStep}
                style={styles.pinInput}
                keyboardType="number-pad"
                maxLength={4}
                secureTextEntry
                autoFocus
                value={pinStep === "enter" ? pinEntry : confirmPin}
                onChangeText={(t) => (pinStep === "enter" ? setPinEntry : setConfirmPin)(t.replace(/\D/g, ""))}
                placeholder="••••"
                placeholderTextColor="#444"
              />
              <TouchableOpacity
                style={[styles.pinBtn, savingPin && { opacity: 0.6 }]}
                onPress={() => void handlePinSubmit()}
                disabled={savingPin}
              >
                <Text style={styles.pinBtnText}>{pinStep === "enter" ? "Next" : "Set PIN"}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.pinCancelBtn} onPress={cancelPinSetup} disabled={savingPin}>
                <Text style={styles.pinCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Upload privacy */}
        <Text style={styles.sectionLabel}>Upload Privacy</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.iconWrap}>
              <Ionicons name="trash-outline" size={19} color={PRIMARY} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>Delete local file after upload</Text>
              <Text style={styles.rowHint}>Remove temp file once confirmed uploaded</Text>
            </View>
            <Switch
              value={settings.deleteLocalAfterUpload}
              onValueChange={v => updateSetting("deleteLocalAfterUpload", v)}
              trackColor={{ false: "#2a2720", true: PRIMARY }}
              thumbColor="white"
              ios_backgroundColor="#2a2720"
            />
          </View>
        </View>

        {/* Witness mode */}
        <Text style={styles.sectionLabel}>Witness Mode</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.iconWrap}>
              <Ionicons name="eye-outline" size={19} color={PRIMARY} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>Notify a witness</Text>
              <Text style={styles.rowHint}>Email a contact after each upload</Text>
            </View>
            <Switch
              value={settings.witnessOnSuccess}
              onValueChange={v => updateSetting("witnessOnSuccess", v)}
              trackColor={{ false: "#2a2720", true: PRIMARY }}
              thumbColor="white"
              ios_backgroundColor="#2a2720"
            />
          </View>
          {settings.witnessOnSuccess && (
            <>
              <View style={styles.divider} />
              <View style={[styles.row, { paddingVertical: 10 }]}>
                <View style={styles.iconWrap}>
                  <Ionicons name="mail-outline" size={19} color="#888" />
                </View>
                <TextInput
                  style={styles.inlineInput}
                  placeholder="witness@example.com"
                  placeholderTextColor="#555"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  value={settings.witnessEmail}
                  onChangeText={v => updateSetting("witnessEmail", v)}
                />
              </View>
            </>
          )}
        </View>

        {/* 2FA */}
        <Text style={styles.sectionLabel}>Two-Factor Authentication</Text>
        <View style={styles.card}>
          <TouchableOpacity style={styles.row} onPress={() => router.push("/settings/security")}>
            <View style={styles.iconWrap}>
              <Ionicons name="shield-checkmark-outline" size={19} color={PRIMARY} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>Two-Factor Authentication</Text>
              <Text style={styles.rowHint}>TOTP via authenticator app</Text>
            </View>
            <Ionicons name="chevron-forward" size={15} color="#444" />
          </TouchableOpacity>
        </View>

        {/* Danger zone */}
        <Text style={[styles.sectionLabel, { color: DANGER + "aa" }]}>Danger Zone</Text>
        <View style={[styles.card, { borderColor: "rgba(239,68,68,0.2)" }]}>
          <TouchableOpacity style={styles.row} onPress={handlePanic}>
            <View style={[styles.iconWrap, { backgroundColor: "rgba(239,68,68,0.12)" }]}>
              <Ionicons name="nuclear-outline" size={19} color={DANGER} />
            </View>
            <View style={styles.rowBody}>
              <Text style={[styles.rowLabel, { color: DANGER }]}>Panic Wipe</Text>
              <Text style={styles.rowHint}>Disconnect all clouds, clear history, sign out</Text>
            </View>
            <Ionicons name="chevron-forward" size={15} color="#444" />
          </TouchableOpacity>
          <View style={styles.divider} />
          <TouchableOpacity style={styles.row} onPress={() => router.push("/settings/delete-account")}>
            <View style={[styles.iconWrap, { backgroundColor: "rgba(239,68,68,0.12)" }]}>
              <Ionicons name="person-remove-outline" size={19} color={DANGER} />
            </View>
            <View style={styles.rowBody}>
              <Text style={[styles.rowLabel, { color: DANGER }]}>Delete Account</Text>
              <Text style={styles.rowHint}>Permanently delete your account and all data</Text>
            </View>
            <Ionicons name="chevron-forward" size={15} color="#444" />
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  pageTitle: { fontSize: 20, fontFamily: "Inter_700Bold", color: "white", marginBottom: 8, paddingHorizontal: 4 },
  sectionLabel: {
    fontSize: 11, color: "#555", fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.5, textTransform: "uppercase",
    paddingHorizontal: 4, paddingTop: 18, paddingBottom: 8,
  },
  card: { backgroundColor: CARD, borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: BORDER },
  divider: { height: 1, backgroundColor: BORDER, marginLeft: 56 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 13, gap: 12 },
  iconWrap: {
    width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(177,152,112,0.12)", flexShrink: 0,
  },
  rowBody: { flex: 1 },
  rowLabel: { fontSize: 15, fontFamily: "Inter_500Medium", color: "white" },
  rowHint: { fontSize: 11, color: "#555", fontFamily: "Inter_400Regular", marginTop: 2 },
  pinLabel: { fontSize: 14, color: "#aaa", fontFamily: "Inter_500Medium", marginBottom: 10 },
  pinInput: {
    backgroundColor: "#111", borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12,
    color: "white", fontSize: 22, textAlign: "center", letterSpacing: 8,
    fontFamily: "Inter_700Bold", borderWidth: 1, borderColor: "rgba(177,152,112,0.2)",
    marginBottom: 12,
  },
  pinBtn: { backgroundColor: PRIMARY, borderRadius: 12, paddingVertical: 13, alignItems: "center" },
  pinBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
  pinCancelBtn: { alignItems: "center", paddingVertical: 12, marginTop: 4 },
  pinCancelText: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular" },
  inlineInput: {
    flex: 1, color: "white", fontSize: 14, fontFamily: "Inter_400Regular", paddingVertical: 4,
  },
});
