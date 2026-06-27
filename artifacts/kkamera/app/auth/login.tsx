import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, Platform, Alert, Image, Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useLogin, getUserFacingMessage } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import type { AuthUser } from "@/contexts/AuthContext";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const { login, hasCompletedWizard } = useAuth();
  const loginMutation = useLogin();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [requires2FA, setRequires2FA] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async () => {
    setError("");
    if (!email || !password) { setError("Please enter your email and password."); return; }
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const result = await loginMutation.mutateAsync({ data: { email, password, totpCode: totp || null } });
      if ((result as any).requires2FA) {
        setRequires2FA(true);
        return;
      }
      if (result.token && result.user) {
        await login(result.token, result.user as AuthUser);
        router.replace(hasCompletedWizard ? "/camera" : "/wizard");
      }
    } catch (e) {
      setError(getUserFacingMessage(e, "Login failed. Check your credentials."));
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TouchableOpacity style={styles.homeBtn} onPress={() => Linking.openURL("https://app.kkamera.app")}>
        <Ionicons name="chevron-back" size={18} color={PRIMARY} />
        <Text style={styles.homeBtnText}>app.kkamera.app</Text>
      </TouchableOpacity>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Logo */}
        <View style={styles.logoWrap}>
          <Image
            source={require("../../assets/images/logo.png")}
            style={styles.logo}
            resizeMode="contain"
            accessibilityLabel="KKamera logo — cloud-based photography"
          />
        </View>

        <Text style={styles.title}>Welcome Back</Text>
        <Text style={styles.subtitle}>Sign in to your account</Text>

        {error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color="#ef4444" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {!requires2FA ? (
          <>
            <View style={styles.field}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                placeholder="your@email.com"
                placeholderTextColor="#555"
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                textContentType="emailAddress"
                value={email}
                onChangeText={setEmail}
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={[styles.input, { flex: 1, borderWidth: 0 }]}
                  placeholder="••••••••"
                  placeholderTextColor="#555"
                  secureTextEntry={!showPassword}
                  autoComplete="current-password"
                  textContentType="password"
                  value={password}
                  onChangeText={setPassword}
                />
                <TouchableOpacity
                  onPress={() => setShowPassword(v => !v)}
                  style={styles.eyeBtn}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? "Hide password" : "Show password"}
                >
                  <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color="#888" />
                </TouchableOpacity>
              </View>
            </View>
          </>
        ) : (
          <View style={styles.field}>
            <Text style={styles.label}>Two-Factor Code</Text>
            <Text style={styles.twoFAHint}>? Open your authenticator app and enter the 6-digit code.</Text>
            <TextInput
              style={[styles.input, styles.totpInput]}
              placeholder="000000"
              placeholderTextColor="#555"
              keyboardType="number-pad"
              maxLength={6}
              value={totp}
              onChangeText={setTotp}
            />
          </View>
        )}

        <TouchableOpacity
          style={[styles.loginBtn, loginMutation.isPending && styles.loginBtnDisabled]}
          onPress={handleLogin}
          disabled={loginMutation.isPending}
        >
          <Text style={styles.loginText}>{loginMutation.isPending ? "Signing in..." : "Sign In"}</Text>
        </TouchableOpacity>

        {!requires2FA && (
          <TouchableOpacity style={styles.forgotLink} onPress={() => router.push("/auth/forgot-password")}>
            <Text style={styles.forgotLinkText}>Forgot password?</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.registerLink} onPress={() => router.push("/auth/register")}>
          <Text style={styles.registerLinkText}>Don't have an account? <Text style={{ color: PRIMARY }}>Create one free</Text></Text>
        </TouchableOpacity>

        <View style={styles.privacyRow}>
          <TouchableOpacity onPress={() => router.push("/settings/privacy")}>
            <Text style={styles.privacyLink}>Privacy Policy</Text>
          </TouchableOpacity>
          <Text style={styles.privacySep}>·</Text>
          <TouchableOpacity onPress={() => router.push("/settings/terms")}>
            <Text style={styles.privacyLink}>Terms of Service</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  content: { paddingHorizontal: 28, paddingBottom: 40, paddingTop: 20 },
  logoWrap: { alignItems: "center", marginBottom: 32 },
  logo: { width: 140, height: 140, marginBottom: 8 },
  title: { fontSize: 22, fontFamily: "Inter_700Bold", color: "white", marginBottom: 6 },
  subtitle: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular", marginBottom: 24 },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "rgba(239,68,68,0.1)", borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)" },
  errorText: { flex: 1, color: "#ef4444", fontSize: 13, fontFamily: "Inter_400Regular" },
  field: { marginBottom: 16 },
  label: { fontSize: 13, color: "#aaa", fontFamily: "Inter_500Medium", marginBottom: 8 },
  input: { backgroundColor: CARD, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, color: "white", fontSize: 15, fontFamily: "Inter_400Regular", borderWidth: 1, borderColor: "rgba(177,152,112,0.2)" },
  inputRow: { flexDirection: "row", alignItems: "center", backgroundColor: CARD, borderRadius: 12, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)", paddingHorizontal: 16 },
  eyeBtn: { paddingLeft: 8 },
  twoFAHint: { fontSize: 12, color: "#888", fontFamily: "Inter_400Regular", marginBottom: 10 },
  totpInput: { fontSize: 24, textAlign: "center", letterSpacing: 8, fontFamily: "Inter_700Bold", color: PRIMARY },
  loginBtn: { backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 16, alignItems: "center", marginTop: 8, marginBottom: 12 },
  forgotLink: { alignItems: "center", marginBottom: 16 },
  forgotLinkText: { fontSize: 13, color: PRIMARY, fontFamily: "Inter_400Regular" },
  loginBtnDisabled: { opacity: 0.6 },
  loginText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
  registerLink: { alignItems: "center", marginBottom: 24 },
  registerLinkText: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular" },
  privacyRow: { flexDirection: "row", justifyContent: "center", gap: 8, alignItems: "center" },
  privacyLink: { fontSize: 12, color: "#666", fontFamily: "Inter_400Regular" },
  privacySep: { color: "#555" },
  homeBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 2 },
  homeBtnText: { fontSize: 13, color: PRIMARY, fontFamily: "Inter_500Medium" },
});
