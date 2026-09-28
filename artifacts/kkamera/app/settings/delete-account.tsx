import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { API_BASE_URL } from "@/lib/config";
import { useUpload } from "@/contexts/UploadContext";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useSettings } from "@/contexts/SettingsContext";
import { clearPin } from "@/lib/appLock";
import { STORE_NAME, openManageSubscriptions, useSubscription } from "@/lib/revenuecat";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";
const DANGER = "#ef4444";

const BASE = API_BASE_URL;

export default function DeleteAccountScreen() {
  const insets = useSafeAreaInsets();
  const { token, logout } = useAuth();
  const { customerInfo, isSubscribed } = useSubscription();
  const { discardQueue } = useUpload();
  const { resetSettings } = useSettings();
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  const handleDelete = async () => {
    if (confirm.toLowerCase() !== "delete my account") {
      Alert.alert("Confirmation required", "Type 'delete my account' exactly to confirm.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/users/me`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Delete failed");
      await discardQueue();
      // The account is gone — don't let the next person on this device inherit
      // its app-lock PIN, witness email or other device settings.
      await clearPin().catch(() => {});
      await resetSettings().catch(() => {});
      await logout(); // the root routing guard then shows the login screen
    } catch {
      Alert.alert("Error", "Could not delete account. Please contact development@koastal.com.au.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={24} color={PRIMARY} />
      </TouchableOpacity>

      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.content, { paddingBottom: 24 + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
      >
        <View style={styles.iconWrap}>
          <Ionicons name="warning-outline" size={48} color={DANGER} />
        </View>

        <Text style={styles.title}>Delete Account</Text>
        <Text style={styles.body}>
          This will permanently delete your account and all associated data including:
        </Text>

        {["Upload history", "Cloud connections", "Subscription data", "Referral records", "All personal information"].map(item => (
          <View key={item} style={styles.bulletRow}>
            <Ionicons name="close-circle" size={16} color={DANGER} />
            <Text style={styles.bulletText}>{item}</Text>
          </View>
        ))}

        <Text style={styles.warning}>This action is irreversible.</Text>

        <View style={styles.billingCard}>
          <View style={styles.billingHeader}>
            <Ionicons name="card-outline" size={18} color={PRIMARY} />
            <Text style={styles.billingTitle}>
              {isSubscribed ? "You have an active subscription" : "Subscriptions"}
            </Text>
          </View>
          <Text style={styles.billingText}>
            Deleting your account does not cancel your subscription. It is billed by the {STORE_NAME}, and
            only you can cancel it there. Cancel it first, or you will keep being charged.
          </Text>
          <TouchableOpacity
            style={styles.manageBtn}
            onPress={() => {
              openManageSubscriptions(customerInfo?.managementURL).catch(() => {
                Alert.alert("Couldn't open subscriptions", `Open your ${STORE_NAME} account settings to manage your subscription.`);
              });
            }}
            accessibilityRole="button"
          >
            <Text style={styles.manageBtnText}>Manage Subscription</Text>
            <Ionicons name="open-outline" size={16} color={PRIMARY} />
          </TouchableOpacity>
        </View>

        <Text style={styles.confirmLabel}>Type "delete my account" to confirm:</Text>
        <TextInput
          style={styles.confirmInput}
          placeholder="delete my account"
          placeholderTextColor="#444"
          value={confirm}
          onChangeText={setConfirm}
          autoCapitalize="none"
        />

        <TouchableOpacity
          style={[styles.deleteBtn, (loading || confirm.toLowerCase() !== "delete my account") && styles.deleteBtnDisabled]}
          onPress={handleDelete}
          disabled={loading || confirm.toLowerCase() !== "delete my account"}
        >
          <Ionicons name="trash-outline" size={18} color="white" />
          <Text style={styles.deleteBtnText}>{loading ? "Deleting..." : "Delete My Account"}</Text>
        </TouchableOpacity>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  content: { padding: 24, alignItems: "center" },
  iconWrap: { width: 96, height: 96, borderRadius: 48, backgroundColor: "rgba(239,68,68,0.1)", alignItems: "center", justifyContent: "center", marginBottom: 20, borderWidth: 1, borderColor: "rgba(239,68,68,0.25)" },
  title: { fontSize: 22, fontFamily: "Inter_700Bold", color: DANGER, marginBottom: 14, textAlign: "center" },
  body: { fontSize: 14, color: "#aaa", fontFamily: "Inter_400Regular", textAlign: "center", marginBottom: 16, lineHeight: 22 },
  bulletRow: { flexDirection: "row", alignItems: "center", gap: 10, alignSelf: "flex-start", marginBottom: 8 },
  bulletText: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular" },
  warning: { fontSize: 13, color: DANGER + "cc", fontFamily: "Inter_500Medium", textAlign: "center", marginTop: 16, marginBottom: 16, lineHeight: 20, backgroundColor: "rgba(239,68,68,0.08)", padding: 14, borderRadius: 10, borderWidth: 1, borderColor: "rgba(239,68,68,0.2)" },
  billingCard: { width: "100%", backgroundColor: CARD, borderRadius: 12, padding: 16, marginBottom: 24, borderWidth: 1, borderColor: "rgba(177,152,112,0.3)" },
  billingHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  billingTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "white" },
  billingText: { fontSize: 13, color: "#aaa", fontFamily: "Inter_400Regular", lineHeight: 20, marginBottom: 12 },
  manageBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: PRIMARY },
  manageBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: PRIMARY },
  confirmLabel: { fontSize: 13, color: "#888", fontFamily: "Inter_400Regular", marginBottom: 8, alignSelf: "flex-start" },
  confirmInput: { backgroundColor: CARD, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, color: "white", fontSize: 14, fontFamily: "Inter_400Regular", borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", width: "100%", marginBottom: 20 },
  deleteBtn: { backgroundColor: DANGER, borderRadius: 14, paddingVertical: 16, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8, width: "100%" },
  deleteBtnDisabled: { opacity: 0.4 },
  deleteBtnText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
});
