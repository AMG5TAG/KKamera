import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useResetPassword } from "@workspace/api-client-react";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

export default function ResetPasswordScreen() {
  const insets = useSafeAreaInsets();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const resetMutation = useResetPassword();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    setError("");
    if (!password) { setError("Please enter a new password."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }

    setLoading(true);
    try {
      await resetMutation.mutateAsync({ data: { token: token ?? "", password } });
      setDone(true);
    } catch (e: any) {
      setError(e?.data?.message || e?.message || "Failed to reset password. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const missingToken = !token;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.replace("/auth/login")}>
        <Ionicons name="chevron-back" size={18} color={PRIMARY} />
        <Text style={styles.backBtnText}>Back to Sign In</Text>
      </TouchableOpacity>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.iconWrap}>
          <Ionicons name="key-outline" size={48} color={PRIMARY} />
        </View>

        <Text style={styles.title}>Reset Password</Text>

        {done ? (
          <>
            <View style={styles.successBox}>
              <Ionicons name="checkmark-circle-outline" size={20} color="#22c55e" />
              <Text style={styles.successText}>
                Your password has been updated. Sign in with your new password.
              </Text>
            </View>
            <TouchableOpacity style={styles.submitBtn} onPress={() => router.replace("/auth/login")}>
              <Text style={styles.submitText}>Go to Sign In</Text>
            </TouchableOpacity>
          </>
        ) : missingToken ? (
          <>
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color="#ef4444" />
              <Text style={styles.errorText}>
                This reset link is missing its token. Open the link from your email, or request a new one.
              </Text>
            </View>
            <TouchableOpacity style={styles.submitBtn} onPress={() => router.replace("/auth/forgot-password")}>
              <Text style={styles.submitText}>Request New Link</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.subtitle}>
              Choose a new password for your account. It must be at least 8 characters.
            </Text>

            {error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle-outline" size={16} color="#ef4444" />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <View style={styles.field}>
              <Text style={styles.label}>New Password</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.inputFlex}
                  placeholder="At least 8 characters"
                  placeholderTextColor="#555"
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoComplete="new-password"
                  value={password}
                  onChangeText={setPassword}
                />
                <TouchableOpacity onPress={() => setShowPassword(s => !s)} style={styles.eyeBtn}>
                  <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color="#888" />
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Confirm Password</Text>
              <TextInput
                style={styles.input}
                placeholder="Repeat new password"
                placeholderTextColor="#555"
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoComplete="new-password"
                value={confirm}
                onChangeText={setConfirm}
              />
            </View>

            <TouchableOpacity
              style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
              onPress={handleSubmit}
              disabled={loading}
            >
              <Text style={styles.submitText}>{loading ? "Updating..." : "Update Password"}</Text>
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
  errorText: { flex: 1, color: "#ef4444", fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 20 },
  successBox: { flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: "rgba(34,197,94,0.1)", borderRadius: 10, padding: 16, marginBottom: 24, borderWidth: 1, borderColor: "rgba(34,197,94,0.3)", width: "100%" },
  successText: { flex: 1, color: "#22c55e", fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 22 },
  field: { marginBottom: 16, width: "100%" },
  label: { fontSize: 13, color: "#aaa", fontFamily: "Inter_500Medium", marginBottom: 8 },
  input: { backgroundColor: CARD, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, color: "white", fontSize: 15, fontFamily: "Inter_400Regular", borderWidth: 1, borderColor: "rgba(177,152,112,0.2)", width: "100%" },
  inputRow: { flexDirection: "row", alignItems: "center", backgroundColor: CARD, borderRadius: 12, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)", width: "100%" },
  inputFlex: { flex: 1, paddingHorizontal: 16, paddingVertical: 14, color: "white", fontSize: 15, fontFamily: "Inter_400Regular" },
  eyeBtn: { paddingHorizontal: 14, paddingVertical: 14 },
  submitBtn: { backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 16, alignItems: "center", marginTop: 8, marginBottom: 16, width: "100%" },
  submitBtnDisabled: { opacity: 0.6 },
  submitText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
  backLink: { alignItems: "center", marginTop: 8 },
  backLinkText: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular" },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 2 },
  backBtnText: { fontSize: 13, color: PRIMARY, fontFamily: "Inter_500Medium" },
});
