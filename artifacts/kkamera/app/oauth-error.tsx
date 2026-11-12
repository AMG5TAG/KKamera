import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet, Animated, Easing } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { forgetOAuthNonceIfMatches, oauthErrorMessage } from "@/lib/oauthPending";

const BG = "#0d0b08";

export default function OAuthErrorScreen() {
  // expo-router has already percent-decoded these; decoding again threw
  // URIError on a literal "%" (kkamera://oauth-error?error=%25) and crashed.
  const { error, provider, nonce } = useLocalSearchParams<{ error?: string; provider?: string; nonce?: string }>();
  // Anyone can craft this link: the error is only a lookup key for a fixed message.
  const message = oauthErrorMessage(error);
  const scale = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Only a link proven to belong to this flow (same nonce) may spend the
    // pending nonce — a crafted link must not cancel a sign-in in progress.
    if (typeof provider === "string" && /^(googledrive|onedrive|dropbox)$/.test(provider) && typeof nonce === "string") {
      void forgetOAuthNonceIfMatches(provider, nonce);
    }
    Animated.sequence([
      Animated.delay(150),
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, tension: 60, friction: 8, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 350, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]),
    ]).start();

    // Back to whatever opened the flow (see oauth-success); Cloud settings only
    // when the link cold-started the app.
    const timer = setTimeout(() => {
      if (router.canGoBack()) router.back();
      else router.replace("/settings/cloud" as any);
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.card, { opacity, transform: [{ scale }] }]}>
        <View style={styles.iconCircle}>
          <Ionicons name="close" size={40} color="white" />
        </View>
        <Text style={styles.title}>Connection Failed</Text>
        <Text style={styles.subtitle}>
          {message}
        </Text>
        <Text style={styles.redirecting}>Returning to settings…</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG, alignItems: "center", justifyContent: "center", padding: 32 },
  card: {
    alignItems: "center", gap: 16, backgroundColor: "#1a1710", borderRadius: 24,
    padding: 40, width: "100%", maxWidth: 360, borderWidth: 1, borderColor: "rgba(177,152,112,0.15)",
  },
  iconCircle: { width: 80, height: 80, borderRadius: 40, backgroundColor: "#ef4444", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  title: { fontSize: 22, fontFamily: "Inter_700Bold", color: "white", textAlign: "center" },
  subtitle: { fontSize: 14, fontFamily: "Inter_400Regular", color: "#aaa", textAlign: "center", lineHeight: 21 },
  redirecting: { fontSize: 12, fontFamily: "Inter_400Regular", color: "#555", marginTop: 8 },
});
