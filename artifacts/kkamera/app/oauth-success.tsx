import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Animated, Easing, ActivityIndicator } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { getListCloudConnectionsQueryKey } from "@workspace/api-client-react";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/contexts/AuthContext";
import { completeOAuthConnection } from "@/lib/oauthPending";

const PRIMARY = "#b19870";
const BG = "#0d0b08";

const PROVIDER_LABELS: Record<string, string> = {
  googledrive: "Google Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
};

type Phase =
  | { kind: "completing" }
  | { kind: "done"; name: string }
  | { kind: "failed"; message: string };

export default function OAuthSuccessScreen() {
  const { connectionId, provider, code, error } = useLocalSearchParams<{
    connectionId?: string;
    provider?: string;
    code?: string;
    error?: string;
  }>();
  const { token, isLoading: authLoading } = useAuth();

  const queryClient = useQueryClient();
  const scale = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const started = useRef(false);

  // Only known providers get a label — the params arrive via a deep link anyone
  // can craft, so nothing from them is echoed verbatim except the error text.
  const providerKey = typeof provider === "string" && PROVIDER_LABELS[provider] ? provider : null;
  const providerLabel = providerKey ? PROVIDER_LABELS[providerKey]! : "Cloud Storage";

  const [phase, setPhase] = useState<Phase>(() =>
    error
      ? { kind: "failed", message: String(error).slice(0, 300) }
      : !code || !providerKey
        ? { kind: "failed", message: "The sign-in did not return a confirmation. Please connect the account again from Settings." }
        : { kind: "completing" }
  );

  // The callback only created a PENDING connection. It is added once the
  // server confirms it with the nonce this device kept from /initiate —
  // anything else (a link started on another account, an expired request)
  // fails and nothing is connected.
  useEffect(() => {
    if (phase.kind !== "completing" || started.current || authLoading) return;
    if (!token) {
      setPhase({ kind: "failed", message: "Please sign in to KKamera, then connect the account again from Settings." });
      return;
    }
    started.current = true;
    const id = typeof connectionId === "string" && /^\d+$/.test(connectionId) ? Number(connectionId) : null;
    void completeOAuthConnection({ provider: providerKey!, code: String(code), connectionId: id }).then((result) => {
      queryClient.invalidateQueries({ queryKey: getListCloudConnectionsQueryKey() });
      setPhase(result.ok ? { kind: "done", name: result.name } : { kind: "failed", message: result.message });
    });
  }, [phase.kind, authLoading, token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    Animated.sequence([
      Animated.delay(150),
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, tension: 60, friction: 8, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 350, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]),
    ]).start();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Return to settings once the outcome is known (errors stay up longer).
  useEffect(() => {
    if (phase.kind === "completing") return;
    const timer = setTimeout(() => {
      router.replace("/settings/cloud" as any);
    }, phase.kind === "failed" ? 6000 : 2500);
    return () => clearTimeout(timer);
  }, [phase.kind]);

  const isError = phase.kind === "failed";

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.card, { opacity, transform: [{ scale }] }]}>
        <View style={[styles.iconCircle, isError && styles.iconCircleError, phase.kind === "completing" && styles.iconCirclePending]}>
          {phase.kind === "completing"
            ? <ActivityIndicator color="white" />
            : <Ionicons name={isError ? "close" : "checkmark"} size={40} color="white" />}
        </View>

        <Text style={styles.title}>
          {phase.kind === "completing" ? "Finishing up…" : isError ? "Connection Failed" : "Connected!"}
        </Text>

        <Text style={styles.subtitle}>
          {phase.kind === "completing"
            ? `Confirming your ${providerLabel} account.`
            : phase.kind === "failed"
              ? `Could not connect to ${providerLabel}.\n${phase.message}`
              : `"${phase.name}" has been added to your cloud connections.`}
        </Text>

        {phase.kind !== "completing" && (
          <Text style={styles.redirecting}>
            Returning to settings…
          </Text>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: BG,
    alignItems: "center", justifyContent: "center",
    padding: 32,
  },
  card: {
    alignItems: "center", gap: 16,
    backgroundColor: "#1a1710", borderRadius: 24,
    padding: 40, width: "100%", maxWidth: 360,
    borderWidth: 1, borderColor: "rgba(177,152,112,0.15)",
  },
  iconCircle: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: "#22c55e",
    alignItems: "center", justifyContent: "center",
    marginBottom: 8,
  },
  iconCircleError: {
    backgroundColor: "#ef4444",
  },
  iconCirclePending: {
    backgroundColor: PRIMARY,
  },
  title: {
    fontSize: 22, fontFamily: "Inter_700Bold",
    color: "white", textAlign: "center",
  },
  subtitle: {
    fontSize: 14, fontFamily: "Inter_400Regular",
    color: "#aaa", textAlign: "center", lineHeight: 21,
  },
  redirecting: {
    fontSize: 12, fontFamily: "Inter_400Regular",
    color: "#555", marginTop: 8,
  },
});
