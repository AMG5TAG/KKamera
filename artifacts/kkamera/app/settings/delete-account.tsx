import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ScrollView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { API_BASE_URL } from "@/lib/config";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";
const DANGER = "#ef4444";

const BASE = API_BASE_URL;

export default function DeleteAccountScreen() {
  const insets = useSafeAreaInsets();
  const { token, logout } = useAuth();
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
      await logout();
    } catch {
      Alert.alert("Error", "Could not delete account. Please contact support@kkamera.app.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={24} color={PRIMARY} />
      </TouchableOpacity>

      <ScrollView contentContainerStyle={styles.content}>
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

        <Text style={styles.warning}>
          This action is irreversible. Your active subscription will be cancelled immediately with no refund.
        </Text>

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
      </ScrollView>
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
  warning: { fontSize: 13, color: DANGER + "cc", fontFamily: "Inter_500Medium", textAlign: "center", marginTop: 16, marginBottom: 24, lineHeight: 20, backgroundColor: "rgba(239,68,68,0.08)", padding: 14, borderRadius: 10, borderWidth: 1, borderColor: "rgba(239,68,68,0.2)" },
  confirmLabel: { fontSize: 13, color: "#888", fontFamily: "Inter_400Regular", marginBottom: 8, alignSelf: "flex-start" },
  confirmInput: { backgroundColor: CARD, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, color: "white", fontSize: 14, fontFamily: "Inter_400Regular", borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", width: "100%", marginBottom: 20 },
  deleteBtn: { backgroundColor: DANGER, borderRadius: 14, paddingVertical: 16, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8, width: "100%" },
  deleteBtnDisabled: { opacity: 0.4 },
  deleteBtnText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
});
