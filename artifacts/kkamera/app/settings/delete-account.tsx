import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { deleteMe, getUserFacingMessage } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { useUpload } from "@/contexts/UploadContext";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useSettings } from "@/contexts/SettingsContext";
import { clearPin } from "@/lib/appLock";
import { STORE_NAME, openManageSubscriptions, useSubscription } from "@/lib/revenuecat";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";
const DANGER = "#ef4444";

/**
 * Strip spaces/dashes and uppercase — the server compares the bare uppercase
 * form. Backup codes are 10 characters shown as XXXXX-XXXXX (legacy codes are
 * 8 hex chars and still valid).
 */
function normaliseCode(input: string): string {
  return input.replace(/[\s-]/g, "").toUpperCase();
}

/** A 6-digit TOTP code, a 10-char backup code, or a legacy 8-hex backup code. */
function isValidCode(code: string): boolean {
  return /^\d{6}$/.test(code) || /^[0-9A-Z]{10}$/.test(code) || /^[0-9A-F]{8}$/.test(code);
}

export default function DeleteAccountScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const { customerInfo, isSubscribed } = useSubscription();
  const { discardQueue } = useUpload();
  const { resetSettings } = useSettings();
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ confirm?: string; password?: string; code?: string; form?: string }>({});

  const needs2FA = user?.twoFAEnabled ?? false;
  const confirmed = confirm.toLowerCase() === "delete my account";

  /** Inline validation, then one explicit final confirmation before deleting. */
  const handleDelete = () => {
    if (loading) return;
    const next: typeof errors = {};
    if (!confirmed) next.confirm = "Type “delete my account” exactly to confirm.";
    if (!password) next.password = "Enter your current password.";
    const totp = normaliseCode(code);
    if (needs2FA && !isValidCode(totp)) next.code = "Enter the 6-digit code from your authenticator app, or a backup code.";
    setErrors(next);
    if (Object.keys(next).length) return;
    Alert.alert(
      "Delete your account?",
      "Your account, upload history and cloud connections will be permanently deleted. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete Permanently", style: "destructive", onPress: () => { void performDelete(totp); } },
      ],
    );
  };

  const performDelete = async (totp: string) => {
    if (loading) return;
    setLoading(true);
    let deleted = false;
    try {
      // Re-authentication: wrong credentials come back as 400/403 (never 401),
      // so a typo shows a message instead of signing the user out.
      await deleteMe({ password, totpCode: needs2FA ? totp : null });
      deleted = true;
    } catch (e) {
      setErrors({ form: getUserFacingMessage(e, "Could not delete account. Please contact development@koastal.com.au.") });
    }
    if (!deleted) { setLoading(false); return; }
    try {
      // Only this account's captures — another account signed in on this
      // device keeps its queued uploads.
      await discardQueue("mine").catch(() => {});
      // The account is gone — don't let the next person on this device inherit
      // its app-lock PIN, witness email or other device settings.
      await clearPin().catch(() => {});
      await resetSettings().catch(() => {});
    } finally {
      // The account is gone server-side: always end the session, even if a
      // local cleanup step failed.
      await logout(); // the root routing guard then shows the login screen
      setLoading(false);
    }
  };

  const clearError = (key: keyof typeof errors) => {
    if (errors[key] || errors.form) setErrors(prev => ({ ...prev, [key]: undefined, form: undefined }));
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
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

        <Text style={styles.title} accessibilityRole="header">Delete Account</Text>
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
          style={[styles.confirmInput, !!errors.confirm && styles.inputError]}
          placeholder="delete my account"
          placeholderTextColor="#777"
          value={confirm}
          onChangeText={v => { setConfirm(v); clearError("confirm"); }}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Type delete my account to confirm"
        />
        <FieldError message={errors.confirm} />

        <Text style={styles.confirmLabel}>Current password:</Text>
        <TextInput
          style={styles.confirmInput}
          placeholder="Enter your password"
          placeholderTextColor="#777"
          value={password}
          onChangeText={v => { setPassword(v); clearError("password"); }}
          accessibilityLabel="Current password"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
        />
        <FieldError message={errors.password} />

        {needs2FA && (
          <>
            <Text style={styles.confirmLabel}>Authenticator code or backup code:</Text>
            <TextInput
              style={styles.confirmInput}
              placeholder="000000"
              placeholderTextColor="#777"
              value={code}
              onChangeText={v => { setCode(v); clearError("code"); }}
              accessibilityLabel="Authenticator code or backup code"
              keyboardType="default"
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              maxLength={11}
            />
            <FieldError message={errors.code} />
          </>
        )}

        {!!errors.form && (
          <View style={styles.formError} accessibilityRole="alert" accessibilityLiveRegion="polite">
            <Ionicons name="alert-circle-outline" size={18} color="#f87171" accessible={false} />
            <Text style={styles.formErrorText}>{errors.form}</Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.deleteBtn, loading && styles.deleteBtnDisabled]}
          onPress={handleDelete}
          disabled={loading}
          accessibilityRole="button"
          accessibilityState={{ disabled: loading, busy: loading }}
        >
          <Ionicons name="trash-outline" size={18} color="white" accessible={false} />
          <Text style={styles.deleteBtnText}>{loading ? "Deleting..." : "Delete My Account"}</Text>
        </TouchableOpacity>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <Text style={styles.fieldError} accessibilityRole="alert" accessibilityLiveRegion="polite">{message}</Text>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  backBtn: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, gap: 4 },
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
  confirmLabel: { fontSize: 13, color: "#a8a29e", fontFamily: "Inter_400Regular", marginBottom: 8, alignSelf: "flex-start" },
  confirmInput: { backgroundColor: CARD, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, color: "white", fontSize: 14, fontFamily: "Inter_400Regular", borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", width: "100%", marginBottom: 20 },
  deleteBtn: { backgroundColor: DANGER, borderRadius: 14, paddingVertical: 16, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8, width: "100%" },
  deleteBtnDisabled: { opacity: 0.5 },
  inputError: { borderColor: "#f87171", marginBottom: 6 },
  fieldError: { fontSize: 12, color: "#f87171", fontFamily: "Inter_500Medium", alignSelf: "flex-start", marginBottom: 16, lineHeight: 16 },
  formError: { width: "100%", flexDirection: "row", alignItems: "flex-start", gap: 8, marginBottom: 14, backgroundColor: "rgba(239,68,68,0.08)", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)" },
  formErrorText: { flex: 1, fontSize: 13, color: "#f87171", fontFamily: "Inter_400Regular", lineHeight: 18 },
  deleteBtnText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
});
