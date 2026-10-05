import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { useVerifyEmail, useResendVerification, getUserFacingMessage } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import type { AuthUser } from "@/contexts/AuthContext";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";
const CODE_LENGTH = 6;
// Matches the server's minimum interval between codes for one account.
const RESEND_COOLDOWN_S = 60;

function firstParam(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

// Reached from Create Account (202 verification_required) or from Sign In
// (403 email_not_verified). The nonce in the params binds the emailed code to
// this device — it's never in the email itself.
export default function VerifyEmailScreen() {
  const insets = useSafeAreaInsets();
  const { login, hasCompletedWizard } = useAuth();
  const verifyMutation = useVerifyEmail();
  const resendMutation = useResendVerification();
  const params = useLocalSearchParams<{ nonce?: string | string[]; email?: string | string[] }>();
  const email = firstParam(params.email);

  const [nonce, setNonce] = useState(firstParam(params.nonce));
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [codeDead, setCodeDead] = useState(false);
  // A code was just sent by the screen that brought us here.
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);
  const lastSubmitted = useRef("");

  // Params can arrive after first render on web.
  useEffect(() => {
    const p = firstParam(params.nonce);
    if (p) setNonce(prev => prev || p);
  }, [params.nonce]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const handleVerify = async (value: string = code) => {
    setError("");
    setInfo("");
    const digits = value.replace(/\D/g, "");
    if (digits.length !== CODE_LENGTH) { setError("Enter the 6-digit code from the email."); return; }
    if (!nonce) { setError("This verification session has ended. Go back and try again."); return; }
    if (verifyMutation.isPending) return;
    lastSubmitted.current = digits;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const result = await verifyMutation.mutateAsync({ data: { nonce, code: digits } });
      if (result.token && result.user) {
        const user = result.user as AuthUser;
        await login(result.token, user);
        router.replace(user.onboardingCompleted || hasCompletedWizard ? "/camera" : "/wizard");
      }
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      if (status === 400) {
        // Wrong, expired, or out of attempts — the server doesn't say which.
        setCodeDead(true);
        setError("That code is invalid or has expired. Check it and try again, or request a new code.");
      } else {
        setError(getUserFacingMessage(e, "Verification failed. Please try again."));
      }
    }
  };

  const handleChange = (text: string) => {
    const digits = text.replace(/\D/g, "").slice(0, CODE_LENGTH);
    setCode(digits);
    if (error) setError("");
    // Auto-submit once complete (not again for the same failed code).
    if (digits.length === CODE_LENGTH && digits !== lastSubmitted.current) void handleVerify(digits);
  };

  const handleResend = async () => {
    if (cooldown > 0 || resendMutation.isPending || !nonce) return;
    setError("");
    setInfo("");
    try {
      const result = await resendMutation.mutateAsync({ data: { nonce } });
      setNonce(result.nonce);
      setCode("");
      setCodeDead(false);
      lastSubmitted.current = "";
      setCooldown(RESEND_COOLDOWN_S);
      setInfo(`A new code is on its way to ${email || "your email"}. Only the newest code works.`);
    } catch (e) {
      setError(getUserFacingMessage(e, "Couldn't send a new code. Please try again."));
    }
  };

  const busy = verifyMutation.isPending;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.topRow}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.canGoBack() ? router.back() : router.replace("/auth/login")} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={24} color={PRIMARY} accessible={false} />
        </TouchableOpacity>
      </View>
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.content, { paddingBottom: 40 + insets.bottom }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
      >
        <View style={styles.iconWrap}>
          <Ionicons name="mail-open-outline" size={40} color={PRIMARY} accessible={false} />
        </View>
        <Text style={styles.title} accessibilityRole="header">Check your email</Text>
        <Text style={styles.subtitle}>
          We sent a 6-digit code to{" "}
          <Text style={styles.email}>{email || "your email address"}</Text>
          . It expires in 30 minutes.
        </Text>

        {error ? (
          <View style={styles.errorBox} accessibilityRole="alert" accessibilityLiveRegion="polite">
            <Ionicons name="alert-circle-outline" size={16} color="#ef4444" accessible={false} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
        {info ? (
          <View style={styles.infoBox} accessibilityLiveRegion="polite">
            <Ionicons name="checkmark-circle-outline" size={16} color={PRIMARY} accessible={false} />
            <Text style={styles.infoText}>{info}</Text>
          </View>
        ) : null}

        <Text style={styles.label}>Verification code</Text>
        <TextInput
          style={styles.codeInput}
          placeholder="000000"
          accessibilityLabel="6-digit verification code"
          accessibilityHint="The code is in the email we just sent you"
          placeholderTextColor="#555"
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          autoCorrect={false}
          autoFocus
          maxLength={CODE_LENGTH}
          value={code}
          onChangeText={handleChange}
          onSubmitEditing={() => void handleVerify()}
          returnKeyType="go"
          editable={!busy}
        />

        <TouchableOpacity
          style={[styles.verifyBtn, busy && styles.btnDisabled]}
          onPress={() => void handleVerify()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy }}
        >
          <Text style={styles.verifyText}>{busy ? "Verifying..." : "Verify"}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.linkBtn, (cooldown > 0 || resendMutation.isPending) && styles.linkDisabled]}
          onPress={handleResend}
          disabled={cooldown > 0 || resendMutation.isPending}
          accessibilityRole="button"
          accessibilityLabel={cooldown > 0 ? `Resend code, available in ${cooldown} seconds` : "Resend code"}
          accessibilityState={{ disabled: cooldown > 0 || resendMutation.isPending, busy: resendMutation.isPending }}
        >
          <Text style={[styles.linkText, codeDead && cooldown <= 0 && styles.linkEmphasis]}>
            {resendMutation.isPending ? "Sending..." : cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.linkBtn}
          onPress={() => router.replace("/auth/register")}
          accessibilityRole="link"
        >
          <Text style={styles.secondaryText}>Wrong address? <Text style={{ color: PRIMARY }}>Use a different email</Text></Text>
        </TouchableOpacity>

        <Text style={styles.footnote}>
          Can't find it? Check your spam or junk folder. The code only works in this app, on this device.
        </Text>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingRight: 8 },
  backBtn: { padding: 16 },
  content: { paddingHorizontal: 28, paddingBottom: 40 },
  iconWrap: { width: 72, height: 72, borderRadius: 36, backgroundColor: "rgba(177,152,112,0.1)", borderWidth: 1, borderColor: "rgba(177,152,112,0.25)", alignItems: "center", justifyContent: "center", marginBottom: 20 },
  title: { fontSize: 26, fontFamily: "Inter_700Bold", color: "white", marginBottom: 6 },
  subtitle: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular", marginBottom: 24, lineHeight: 21 },
  email: { color: PRIMARY, fontFamily: "Inter_500Medium" },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(239,68,68,0.1)", borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)" },
  errorText: { flex: 1, color: "#ef4444", fontSize: 13, fontFamily: "Inter_400Regular" },
  infoBox: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(177,152,112,0.1)", borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: "rgba(177,152,112,0.25)" },
  infoText: { flex: 1, color: PRIMARY, fontSize: 13, fontFamily: "Inter_400Regular" },
  label: { fontSize: 13, color: "#aaa", fontFamily: "Inter_500Medium", marginBottom: 8 },
  codeInput: { backgroundColor: CARD, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)", fontSize: 28, textAlign: "center", letterSpacing: 10, fontFamily: "Inter_700Bold", color: PRIMARY, marginBottom: 20 },
  verifyBtn: { backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 16, alignItems: "center", marginBottom: 12 },
  btnDisabled: { opacity: 0.6 },
  verifyText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
  linkBtn: { alignItems: "center", paddingVertical: 10 },
  linkDisabled: { opacity: 0.6 },
  linkText: { fontSize: 14, color: PRIMARY, fontFamily: "Inter_500Medium" },
  linkEmphasis: { fontFamily: "Inter_700Bold" },
  secondaryText: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular" },
  footnote: { fontSize: 12, color: "#666", fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 16, lineHeight: 18 },
});
