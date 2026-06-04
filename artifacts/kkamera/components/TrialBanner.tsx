import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

const PRIMARY = "#b19870";

interface Props {
  daysLeft: number;
}

export function TrialBanner({ daysLeft }: Props) {
  if (daysLeft > 3) return null;

  const urgent = daysLeft <= 1;
  const message = daysLeft === 0
    ? "Your trial expires today"
    : `Your trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;

  return (
    <TouchableOpacity
      style={[styles.banner, urgent && styles.bannerUrgent]}
      onPress={() => router.push("/settings/subscription")}
      activeOpacity={0.8}
    >
      <Ionicons name="time-outline" size={16} color={urgent ? "#ef4444" : PRIMARY} />
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
