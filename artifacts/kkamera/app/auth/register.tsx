import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, Platform, Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useRegister } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import type { AuthUser } from "@/contexts/AuthContext";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

export default function RegisterScreen() {
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const registerMutation = useRegister();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [agreed, setAgreed] = useState(false);

  const handleRegister = async () => {
    setError("");
    if (!name.trim()) { setError("Please enter your name."); return; }
    if (!email.trim()) { setError("Please enter your email."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (!agreed) { setError("Please accept the Terms of Service to continue."); return; }
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const result = await registerMutation.mutateAsync({
        data: { name, email, password, referralCode: referralCode.trim() || undefined }
      });
      if (result.token && result.user) {
        await login(result.token, result.user as AuthUser);
        router.replace("/wizard");
      }
    } catch (e: any) {
      setError(e?.data?.message || e?.message || "Registration failed. Please try again.");
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.topRow}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={PRIMARY} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.homeBtn} onPress={() => Linking.openURL("https://kkamera.app")}>
          <Ionicons name="chevron-back" size={18} color={PRIMARY} />
          <Text style={styles.homeBtnText}>kkamera.app</Text>
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Create Account</Text>
        <Text style={styles.subtitle}>Start your 14-day free trial — no credit card needed</Text>

        <View style={styles.trialBadge}>
          <Ionicons name="gift-outline" size={18} color={PRIMARY} />
          <Text style={styles.trialText}>14-day free trial · Then $25/year</Text>
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color="#ef4444" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <Field label="Your Name" hint="How you'll be identified in KKamera">
          <TextInput style={styles.input} placeholder="Full name" placeholderTextColor="#555" autoCapitalize="words" value={name} onChangeText={setName} />
        </Field>
        <Field label="Email Address" hint="Used for your account login">
          <TextInput style={styles.input} placeholder="your@email.com" placeholderTextColor="#555" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
        </Field>
        <Field label="Password" hint="At least 8 characters for security">
          <View style={styles.inputRow}>
            <TextInput style={[styles.input, { flex: 1, borderWidth: 0 }]} placeholder="••••••••" placeholderTextColor="#555" secureTextEntry={!showPassword} value={password} onChangeText={setPassword} />
            <TouchableOpacity onPress={() => setShowPassword(v => !v)} style={styles.eyeBtn}>
              <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color="#888" />
            </TouchableOpacity>
          </View>
        </Field>
        <Field label="Referral Code (optional)" hint="? Enter a friend's code to help them earn a free year">
          <TextInput style={[styles.input, { textTransform: "uppercase" }]} placeholder="e.g. JOHN42K" placeholderTextColor="#555" autoCapitalize="characters" value={referralCode} onChangeText={setReferralCode} />
        </Field>

        <TouchableOpacity style={styles.agreeRow} onPress={() => setAgreed(v => !v)}>
          <View style={[styles.checkbox, agreed && styles.checkboxChecked]}>
            {agreed && <Ionicons name="checkmark" size={14} color="white" />}
          </View>
          <Text style={styles.agreeText}>
            I agree to the{" "}
            <Text style={{ color: PRIMARY }} onPress={() => router.push("/settings/terms")}>Terms of Service</Text>
            {" "}and{" "}
            <Text style={{ color: PRIMARY }} onPress={() => router.push("/settings/privacy")}>Privacy Policy</Text>
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.registerBtn, registerMutation.isPending && styles.btnDisabled]} onPress={handleRegister} disabled={registerMutation.isPending}>
          <Text style={styles.registerText}>{registerMutation.isPending ? "Creating Account..." : "Create Free Account"}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.loginLink} onPress={() => router.back()}>
          <Text style={styles.loginLinkText}>Already have an account? <Text style={{ color: PRIMARY }}>Sign in</Text></Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={styles.label}>{label}</Text>
      {hint && <Text style={styles.hint}>{hint}</Text>}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingRight: 8 },
  backBtn: { padding: 16 },
  homeBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 2 },
  homeBtnText: { fontSize: 13, color: PRIMARY, fontFamily: "Inter_500Medium" },
  content: { paddingHorizontal: 28, paddingBottom: 40 },
  title: { fontSize: 26, fontFamily: "Inter_700Bold", color: "white", marginBottom: 6 },
  subtitle: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular", marginBottom: 20 },
  trialBadge: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(177,152,112,0.1)", borderRadius: 10, padding: 12, marginBottom: 20, borderWidth: 1, borderColor: "rgba(177,152,112,0.25)" },
  trialText: { fontSize: 13, color: PRIMARY, fontFamily: "Inter_500Medium" },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(239,68,68,0.1)", borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)" },
  errorText: { flex: 1, color: "#ef4444", fontSize: 13, fontFamily: "Inter_400Regular" },
  label: { fontSize: 13, color: "#aaa", fontFamily: "Inter_500Medium", marginBottom: 4 },
  hint: { fontSize: 11, color: "#666", fontFamily: "Inter_400Regular", marginBottom: 8 },
  input: { backgroundColor: CARD, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, color: "white", fontSize: 15, fontFamily: "Inter_400Regular", borderWidth: 1, borderColor: "rgba(177,152,112,0.2)" },
  inputRow: { flexDirection: "row", alignItems: "center", backgroundColor: CARD, borderRadius: 12, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)", paddingHorizontal: 16 },
  eyeBtn: { paddingLeft: 8 },
  agreeRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 20, marginTop: 4 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: "#555", alignItems: "center", justifyContent: "center", marginTop: 1 },
  checkboxChecked: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  agreeText: { flex: 1, fontSize: 13, color: "#888", fontFamily: "Inter_400Regular", lineHeight: 20 },
  registerBtn: { backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 16, alignItems: "center", marginBottom: 16 },
  btnDisabled: { opacity: 0.6 },
  registerText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
  loginLink: { alignItems: "center" },
  loginLinkText: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular" },
});
