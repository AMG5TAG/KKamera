import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ActivityIndicator, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useChangePassword, getUserFacingMessage } from "@workspace/api-client-react";
import { useAuth, type AuthUser } from "@/contexts/AuthContext";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

/** UTF-8 byte length — the server caps passwords at 72 bytes (bcrypt's limit). */
function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Strip spaces/dashes and uppercase — backup codes are 8 hex chars, compared uppercase by the server. */
function normaliseCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

export default function ChangePasswordScreen() {
  const insets = useSafeAreaInsets();
  const { user, login } = useAuth();
  const changeMutation = useChangePassword();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState("");

  const needs2FA = user?.twoFAEnabled ?? false;
  const loading = changeMutation.isPending;

  const handleSubmit = async () => {
    setError("");
    if (!current) { setError("Please enter your current password."); return; }
    if (next.length < 8) { setError("New password must be at least 8 characters."); return; }
    if (utf8Bytes(next) > 72) { setError("New password is too long (maximum 72 bytes)."); return; }
    if (next !== confirm) { setError("New passwords don't match."); return; }
    const totp = normaliseCode(code);
    if (needs2FA && !/^\d{6}$/.test(totp) && !/^[0-9A-F]{8}$/.test(totp)) {
      setError("Enter the 6-digit code from your authenticator app, or a backup code.");
      return;
    }

    try {
      const result = await changeMutation.mutateAsync({
        data: { currentPassword: current, newPassword: next, totpCode: needs2FA ? totp : null },
      });
      // Other sessions are now signed out; keep this device signed in with the
      // fresh token the server issued.
      await login(result.token, result.user as AuthUser);
      setCurrent(""); setNext(""); setConfirm(""); setCode("");
      Alert.alert("Password changed", "Your password has been updated. Other devices have been signed out.");
      router.back();
    } catch (e) {
      setError(getUserFacingMessage(e, "Could not change your password. Please try again."));
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={18} color={PRIMARY} />
        <Text style={styles.backBtnText}>Security</Text>
      </TouchableOpacity>

      <KeyboardAwareScrollViewCompat
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 20) + 20 }]}
        showsVerticalScrollIndicator={false}
        bottomOffset={24}
      >
        <View style={styles.iconWrap}>
          <Ionicons name="lock-closed-outline" size={44} color={PRIMARY} />
        </View>
        <Text style={styles.title}>Change Password</Text>
        <Text style={styles.subtitle}>
          Changing your password signs you out on every other device.
        </Text>

        {error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color="#ef4444" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.field}>
          <Text style={styles.label}>Current Password</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.inputFlex}
              placeholder="Current password"
              placeholderTextColor="#555"
              secureTextEntry={!showPasswords}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              textContentType="password"
              value={current}
              onChangeText={setCurrent}
            />
            <TouchableOpacity
              onPress={() => setShowPasswords(s => !s)}
              style={styles.eyeBtn}
              accessibilityLabel={showPasswords ? "Hide passwords" : "Show passwords"}
            >
              <Ionicons name={showPasswords ? "eye-off-outline" : "eye-outline"} size={20} color="#888" />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>New Password</Text>
          <TextInput
            style={styles.input}
            placeholder="At least 8 characters"
            placeholderTextColor="#555"
            secureTextEntry={!showPasswords}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            value={next}
            onChangeText={setNext}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Confirm New Password</Text>
          <TextInput
            style={styles.input}
            placeholder="Repeat new password"
            placeholderTextColor="#555"
            secureTextEntry={!showPasswords}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="new-password"
            textContentType="newPassword"
            value={confirm}
            onChangeText={setConfirm}
            returnKeyType={needs2FA ? "next" : "done"}
            onSubmitEditing={needs2FA ? undefined : () => void handleSubmit()}
          />
        </View>

        {needs2FA && (
          <View style={styles.field}>
            <Text style={styles.label}>Two-Factor Code</Text>
            <TextInput
              style={styles.input}
              placeholder="6-digit code or backup code"
              placeholderTextColor="#555"
              keyboardType="default"
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              maxLength={10}
              value={code}
              onChangeText={setCode}
              returnKeyType="done"
              onSubmitEditing={() => void handleSubmit()}
            />
          </View>
        )}

        <TouchableOpacity
          style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
          onPress={() => void handleSubmit()}
          disabled={loading}
        >
          {loading ? <ActivityIndicator color="white" /> : <Text style={styles.submitText}>Update Password</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.forgotLink} onPress={() => router.push("/auth/forgot-password")}>
          <Text style={styles.forgotText}>Forgot your current password?</Text>
        </TouchableOpacity>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 24, paddingTop: 12 },
  iconWrap: { width: 88, height: 88, borderRadius: 44, backgroundColor: CARD, alignItems: "center", justifyContent: "center", marginBottom: 20, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)", alignSelf: "center" },
  title: { fontSize: 22, fontFamily: "Inter_700Bold", color: "white", marginBottom: 8, textAlign: "center" },
  subtitle: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular", marginBottom: 24, textAlign: "center", lineHeight: 22 },
  errorBox: { flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: "rgba(239,68,68,0.1)", borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)" },
  errorText: { flex: 1, color: "#ef4444", fontSize: 13, fontFamily: "Inter_400Regular", lineHeight: 20 },
  field: { marginBottom: 16 },
  label: { fontSize: 13, color: "#aaa", fontFamily: "Inter_500Medium", marginBottom: 8 },
  input: { backgroundColor: CARD, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, color: "white", fontSize: 15, fontFamily: "Inter_400Regular", borderWidth: 1, borderColor: "rgba(177,152,112,0.2)" },
  inputRow: { flexDirection: "row", alignItems: "center", backgroundColor: CARD, borderRadius: 12, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)" },
  inputFlex: { flex: 1, paddingHorizontal: 16, paddingVertical: 14, color: "white", fontSize: 15, fontFamily: "Inter_400Regular" },
  eyeBtn: { paddingHorizontal: 14, paddingVertical: 14 },
  submitBtn: { backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 16, alignItems: "center", marginTop: 8, marginBottom: 16 },
  submitBtnDisabled: { opacity: 0.6 },
  submitText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
  forgotLink: { alignItems: "center", paddingVertical: 8 },
  forgotText: { fontSize: 13, color: "#888", fontFamily: "Inter_400Regular" },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 2 },
  backBtnText: { fontSize: 13, color: PRIMARY, fontFamily: "Inter_500Medium" },
});
