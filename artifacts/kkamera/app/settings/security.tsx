import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput, Image, Alert, Platform, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useSetup2FA, useVerify2FA, useDisable2FA, useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

export default function SecurityScreen() {
  const insets = useSafeAreaInsets();
  const { user, updateUser } = useAuth();
  const queryClient = useQueryClient();

  const setup2FAMutation = useSetup2FA();
  const verify2FAMutation = useVerify2FA();
  const disable2FAMutation = useDisable2FA();

  const [setupData, setSetupData] = useState<{ secret: string; qrCodeUrl: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"idle" | "setup" | "disable">("idle");

  const handleSetup = async () => {
    try {
      const result = await setup2FAMutation.mutateAsync();
      setSetupData(result);
      setMode("setup");
    } catch {
      Alert.alert("Error", "Could not start 2FA setup. Please try again.");
    }
  };

  const handleVerify = async () => {
    if (code.length !== 6) { Alert.alert("Error", "Please enter the 6-digit code from your authenticator app."); return; }
    try {
      await verify2FAMutation.mutateAsync({ data: { code } });
      if (user) updateUser({ ...user, twoFAEnabled: true });
      queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      setMode("idle");
      setCode("");
      setSetupData(null);
      Alert.alert("2FA Enabled", "Two-factor authentication is now active on your account.");
    } catch {
      Alert.alert("Error", "Invalid code. Please try again.");
    }
  };

  const handleDisable = async () => {
    if (code.length !== 6) { Alert.alert("Error", "Please enter your current 6-digit authenticator code to disable 2FA."); return; }
    try {
      await disable2FAMutation.mutateAsync({ data: { code } });
      if (user) updateUser({ ...user, twoFAEnabled: false });
      queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      setMode("idle");
      setCode("");
      Alert.alert("2FA Disabled", "Two-factor authentication has been removed from your account.");
    } catch {
      Alert.alert("Error", "Invalid code. Could not disable 2FA.");
    }
  };

  const is2FAEnabled = user?.twoFAEnabled ?? false;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
    <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
      <Ionicons name="chevron-back" size={24} color={PRIMARY} />
    </TouchableOpacity>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 20) + 20 }}>
      {/* Status card */}
      <View style={[styles.statusCard, is2FAEnabled && styles.statusCardOn]}>
        <Ionicons name={is2FAEnabled ? "shield-checkmark" : "shield-outline"} size={40} color={is2FAEnabled ? "#22c55e" : "#888"} />
        <Text style={styles.statusTitle}>{is2FAEnabled ? "2FA is Active" : "2FA is Disabled"}</Text>
        <Text style={styles.statusSub}>
          {is2FAEnabled
            ? "Your account is protected with two-factor authentication."
            : "Enable 2FA to add an extra layer of security to your account."
          }
        </Text>
      </View>

      {/* What is 2FA */}
      {!is2FAEnabled && mode === "idle" && (
        <>
          <Text style={styles.sectionTitle}>What is Two-Factor Authentication?</Text>
          <View style={styles.infoCard}>
            <Ionicons name="phone-portrait-outline" size={18} color={PRIMARY} />
            <Text style={styles.infoText}>When enabled, you'll need to enter a 6-digit code from an authenticator app (like Google Authenticator or Authy) each time you sign in.</Text>
          </View>
          <View style={styles.infoCard}>
            <Ionicons name="key-outline" size={18} color={PRIMARY} />
            <Text style={styles.infoText}>Even if someone gets your password, they can't access your account without the code from your phone.</Text>
          </View>
          <TouchableOpacity
            style={[styles.actionBtn, setup2FAMutation.isPending && styles.btnDisabled]}
            onPress={handleSetup}
            disabled={setup2FAMutation.isPending}
          >
            {setup2FAMutation.isPending ? <ActivityIndicator color="white" /> : (
              <>
                <Ionicons name="shield-checkmark-outline" size={18} color="white" />
                <Text style={styles.actionBtnText}>Enable Two-Factor Authentication</Text>
              </>
            )}
          </TouchableOpacity>
        </>
      )}

      {/* Setup flow */}
      {mode === "setup" && setupData && (
        <>
          <Text style={styles.sectionTitle}>Step 1: Scan the QR Code</Text>
          <Text style={styles.bodyText}>Open your authenticator app (Google Authenticator, Authy, etc.) and scan this QR code:</Text>
          <View style={styles.qrWrap}>
            <Image source={{ uri: setupData.qrCodeUrl }} style={styles.qrCode} resizeMode="contain" accessibilityLabel="Two-factor authentication QR code" />
          </View>
          <Text style={styles.manualSecret}>Or enter manually: <Text style={{ color: PRIMARY, fontFamily: "Inter_600SemiBold" }}>{setupData.secret}</Text></Text>

          <Text style={[styles.sectionTitle, { marginTop: 20 }]}>Step 2: Save Backup Codes</Text>
          <Text style={styles.bodyText}>? Store these codes safely. They let you access your account if you lose your phone:</Text>
          <View style={styles.backupGrid}>
            {setupData.backupCodes.map((c, i) => (
              <View key={i} style={styles.backupCode}><Text style={styles.backupCodeText}>{c}</Text></View>
            ))}
          </View>

          <Text style={[styles.sectionTitle, { marginTop: 20 }]}>Step 3: Verify</Text>
          <Text style={styles.bodyText}>Enter the 6-digit code from your authenticator app to confirm setup:</Text>
          <TextInput
            style={styles.codeInput}
            placeholder="000000"
            placeholderTextColor="#555"
            keyboardType="number-pad"
            maxLength={6}
            value={code}
            onChangeText={setCode}
          />
          <TouchableOpacity
            style={[styles.actionBtn, verify2FAMutation.isPending && styles.btnDisabled]}
            onPress={handleVerify}
            disabled={verify2FAMutation.isPending}
          >
            {verify2FAMutation.isPending ? <ActivityIndicator color="white" /> : (
              <Text style={styles.actionBtnText}>Confirm & Enable 2FA</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelBtn} onPress={() => { setMode("idle"); setSetupData(null); setCode(""); }}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </>
      )}

      {/* Disable flow */}
      {is2FAEnabled && mode === "idle" && (
        <>
          <Text style={styles.sectionTitle}>Manage 2FA</Text>
          <Text style={styles.bodyText}>To disable two-factor authentication, enter your current authenticator code:</Text>
          <TextInput
            style={styles.codeInput}
            placeholder="000000"
            placeholderTextColor="#555"
            keyboardType="number-pad"
            maxLength={6}
            value={code}
            onChangeText={setCode}
          />
          <TouchableOpacity
            style={[styles.disableBtn, disable2FAMutation.isPending && styles.btnDisabled]}
            onPress={handleDisable}
            disabled={disable2FAMutation.isPending}
          >
            {disable2FAMutation.isPending ? <ActivityIndicator color="white" /> : (
              <Text style={styles.disableBtnText}>Disable 2FA</Text>
            )}
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  statusCard: { backgroundColor: CARD, borderRadius: 16, padding: 20, alignItems: "center", marginBottom: 24, borderWidth: 1, borderColor: "rgba(177,152,112,0.15)" },
  statusCardOn: { borderColor: "rgba(34,197,94,0.3)", backgroundColor: "rgba(34,197,94,0.05)" },
  statusTitle: { fontSize: 18, fontFamily: "Inter_700Bold", color: "white", marginTop: 12, marginBottom: 6 },
  statusSub: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
  sectionTitle: { fontSize: 11, color: "#666", fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 12 },
  infoCard: { flexDirection: "row", alignItems: "flex-start", gap: 12, backgroundColor: CARD, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: "rgba(177,152,112,0.1)" },
  infoText: { flex: 1, fontSize: 14, color: "#ccc", fontFamily: "Inter_400Regular", lineHeight: 20 },
  bodyText: { fontSize: 14, color: "#aaa", fontFamily: "Inter_400Regular", lineHeight: 20, marginBottom: 12 },
  qrWrap: { alignItems: "center", backgroundColor: "white", borderRadius: 12, padding: 16, marginBottom: 12, alignSelf: "center" },
  qrCode: { width: 180, height: 180 },
  manualSecret: { fontSize: 12, color: "#888", fontFamily: "Inter_400Regular", textAlign: "center", marginBottom: 8 },
  backupGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  backupCode: { backgroundColor: "#1e1c15", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: "rgba(177,152,112,0.15)" },
  backupCodeText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: PRIMARY, letterSpacing: 1 },
  codeInput: { backgroundColor: "#1a1710", borderRadius: 12, paddingHorizontal: 16, paddingVertical: 16, color: PRIMARY, fontSize: 28, fontFamily: "Inter_700Bold", textAlign: "center", letterSpacing: 8, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)", marginBottom: 16 },
  actionBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 15, marginBottom: 10 },
  btnDisabled: { opacity: 0.6 },
  actionBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
  cancelBtn: { alignItems: "center", paddingVertical: 12 },
  cancelBtnText: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular" },
  disableBtn: { alignItems: "center", justifyContent: "center", borderRadius: 14, paddingVertical: 15, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", marginBottom: 10 },
  disableBtnText: { fontSize: 15, fontFamily: "Inter_500Medium", color: "#ef4444" },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
});
