import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet, Animated, Easing } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

const BG = "#0d0b08";

export default function OAuthErrorScreen() {
  const { error, provider } = useLocalSearchParams<{ error?: string; provider?: string }>();
  const scale = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.delay(150),
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, tension: 60, friction: 8, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 350, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]),
    ]).start();

    const timer = setTimeout(() => router.replace("/settings/cloud" as any), 5000);
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
          {decodeURIComponent(error ?? "OAuth authorisation was cancelled or failed.")}
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
