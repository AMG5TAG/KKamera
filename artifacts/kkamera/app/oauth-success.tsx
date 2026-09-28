import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet, Animated, Easing } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { getListCloudConnectionsQueryKey, useListCloudConnections } from "@workspace/api-client-react";
import { Ionicons } from "@expo/vector-icons";

const PRIMARY = "#b19870";
const BG = "#0d0b08";

const PROVIDER_LABELS: Record<string, string> = {
  googledrive: "Google Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
};

export default function OAuthSuccessScreen() {
  const { connectionId, provider, error } = useLocalSearchParams<{
    connectionId?: string;
    name?: string;
    provider?: string;
    error?: string;
  }>();

  const queryClient = useQueryClient();
  const scale = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  const isError = !!error;
  // Only known providers get a label — the params arrive via a deep link anyone
  // can craft, so nothing from them is echoed verbatim except the error text.
  const providerLabel = PROVIDER_LABELS[provider ?? ""] ?? "Cloud Storage";

  // The `name` param is spoofable; show a connection name only once the API
  // confirms this user really has a connection with that id.
  const { data: connections } = useListCloudConnections({
    query: { enabled: !isError && !!connectionId, queryKey: getListCloudConnectionsQueryKey() },
  });
  const confirmed = connections?.find((c) => String(c.id) === connectionId);

  useEffect(() => {
    if (!isError && connectionId) {
      queryClient.invalidateQueries({ queryKey: getListCloudConnectionsQueryKey() });
    }

    Animated.sequence([
      Animated.delay(150),
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, tension: 60, friction: 8, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 350, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]),
    ]).start();

    const timer = setTimeout(() => {
      router.replace("/settings/cloud" as any);
    }, isError ? 4000 : 2500);

    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.card, { opacity, transform: [{ scale }] }]}>
        <View style={[styles.iconCircle, isError && styles.iconCircleError]}>
          <Ionicons
            name={isError ? "close" : "checkmark"}
            size={40}
            color="white"
          />
        </View>

        <Text style={styles.title}>
          {isError ? "Connection Failed" : "Connected!"}
        </Text>

        <Text style={styles.subtitle}>
          {isError
            ? `Could not connect to ${providerLabel}.\n${String(error).slice(0, 300)}`
            : confirmed
              ? `"${confirmed.name}" has been added to your cloud connections.`
              : `Your ${providerLabel} account has been connected.`}
        </Text>

        <Text style={styles.redirecting}>
          Returning to settings…
        </Text>
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
