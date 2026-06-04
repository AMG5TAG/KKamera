import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

const API_BASE = process.env["EXPO_PUBLIC_API_URL"] ?? "";

export default function ForgotPasswordScreen() {
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    setError("");
    if (!email.trim()) { setError("Please enter your email address."); return; }

    setLoading(true);
    try {
      await fetch(`${API_BASE}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      // Always show success to avoid email enumeration
      setSent(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={18} color={PRIMARY} />
        <Text style={styles.backBtnText}>Back to Sign In</Text>
      </TouchableOpacity>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.iconWrap}>
          <Ionicons name="lock-closed-outline" size={48} color={PRIMARY} />
        </View>

        <Text style={styles.title}>Forgot Password</Text>
        <Text style={styles.subtitle}>
          Enter your email and we'll send you a reset link if an account exists.
        </Text>

        {sent ? (
          <View style={styles.successBox}>
            <Ionicons name="checkmark-circle-outline" size={20} color="#22c55e" />
            <Text style={styles.successText}>
              If an account exists for that email, a reset link has been sent. Check your inbox.
            </Text>
          </View>
        ) : (
          <>
            {error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle-outline" size={16} color="#ef4444" />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <View style={styles.field}>
              <Text style={styles.label}>Email Address</Text>
              <TextInput
                style={styles.input}
                placeholder="your@email.com"
                placeholderTextColor="#555"
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                value={email}
                onChangeText={setEmail}
              />
            </View>

            <TouchableOpacity
              style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
              onPress={handleSubmit}
              disabled={loading}
            >
              <Text style={styles.submitText}>{loading ? "Sending..." : "Send Reset Link"}</Text>
            </TouchableOpacity>
          </>
        )}

        <TouchableOpacity style={styles.backLink} onPress={() => router.replace("/auth/login")}>
          <Text style={styles.backLinkText}>Return to <Text style={{ color: PRIMARY }}>Sign In</Text></Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 28, paddingBottom: 40, paddingTop: 20, alignItems: "center" },
  iconWrap: { width: 96, height: 96, borderRadius: 48, backgroundColor: CARD, alignItems: "center", justifyContent: "center", marginBottom: 24, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)" },
  title: { fontSize: 22, fontFamily: "Inter_700Bold", color: "white", marginBottom: 10, textAlign: "center" },
  subtitle: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular", marginBottom: 28, textAlign: "center", lineHeight: 22 },
  errorBox: { flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: "rgba(239,68,68,0.1)", borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", width: "100%" },
  errorText: { flex: 1, color: "#ef4444", fontSize: 13, fontFamily: "Inter_400Regular" },
  successBox: { flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: "rgba(34,197,94,0.1)", borderRadius: 10, padding: 16, marginBottom: 24, borderWidth: 1, borderColor: "rgba(34,197,94,0.3)", width: "100%" },
  successText: { flex: 1, color: "#22c55e", fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 22 },
  field: { marginBottom: 16, width: "100%" },
  label: { fontSize: 13, color: "#aaa", fontFamily: "Inter_500Medium", marginBottom: 8 },
  input: { backgroundColor: CARD, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, color: "white", fontSize: 15, fontFamily: "Inter_400Regular", borderWidth: 1, borderColor: "rgba(177,152,112,0.2)", width: "100%" },
  submitBtn: { backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 16, alignItems: "center", marginTop: 8, marginBottom: 16, width: "100%" },
  submitBtnDisabled: { opacity: 0.6 },
  submitText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
  backLink: { alignItems: "center", marginTop: 8 },
  backLinkText: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular" },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 2 },
  backBtnText: { fontSize: 13, color: PRIMARY, fontFamily: "Inter_500Medium" },
});
