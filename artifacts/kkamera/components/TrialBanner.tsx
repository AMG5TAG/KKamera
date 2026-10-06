import React from "react";
import { Text, StyleSheet, TouchableOpacity } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { trialTimeLeft } from "@/lib/trialTime";

const PRIMARY = "#b19870";

interface Props {
  trialEnd: Date | string;
}

const HOUR_MS = 3_600_000;

export function TrialBanner({ trialEnd }: Props) {
  const left = trialTimeLeft(trialEnd);
  // A 24-hour trial is always inside this window; older 14-day trials show in their last 3 days.
  if (left.ms > 72 * HOUR_MS) return null;

  const urgent = left.ms <= 3 * HOUR_MS;
  const message = left.ms === 0
    ? "Your trial has ended"
    : `Your trial ends in ${left.label}`;

  return (
    <TouchableOpacity
      style={[styles.banner, urgent && styles.bannerUrgent]}
      onPress={() => router.push("/settings/subscription")}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={`${message}. Subscribe.`}
      accessibilityHint="Opens subscription settings"
    >
      <Ionicons name="time-outline" size={16} color={urgent ? "#ef4444" : PRIMARY} accessible={false} />
      <Text style={[styles.text, urgent && styles.textUrgent]}>{message}</Text>
      <Text style={[styles.cta, urgent && styles.ctaUrgent]}>Subscribe →</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "rgba(177,152,112,0.12)",
    borderBottomWidth: 1, borderBottomColor: "rgba(177,152,112,0.25)",
    paddingHorizontal: 16, paddingVertical: 10,
  },
  bannerUrgent: {
    backgroundColor: "rgba(239,68,68,0.1)",
    borderBottomColor: "rgba(239,68,68,0.25)",
  },
  text: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium", color: PRIMARY },
  textUrgent: { color: "#ef4444" },
  cta: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: PRIMARY },
  ctaUrgent: { color: "#ef4444" },
});
