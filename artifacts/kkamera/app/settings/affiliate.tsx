import React from "react";
import { View, Text, StyleSheet, ScrollView, Platform, TouchableOpacity, Share, FlatList, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useGetAffiliateStats, useGetReferrals } from "@workspace/api-client-react";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

export default function AffiliateScreen() {
  const insets = useSafeAreaInsets();
  const { data: stats, isLoading: statsLoading } = useGetAffiliateStats();
  const { data: referrals, isLoading: refLoading } = useGetReferrals();

  const progress = (stats?.completedReferrals ?? 0) % 5;
  const nextMilestone = 5;

  const handleShare = async () => {
    if (!stats?.referralCode) return;
    try {
      await Share.share({
        message: `Try KKamera — the camera app that uploads directly to your cloud storage, leaving no trace on your device! Use my code ${stats.referralCode} when signing up to get started. https://kkamera.app`,
        title: "Try KKamera",
      });
    } catch { /* ignore */ }
  };

  if (statsLoading) {
    return <View style={styles.center}><ActivityIndicator color={PRIMARY} /></View>;
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
    <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
      <Ionicons name="chevron-back" size={24} color={PRIMARY} />
    </TouchableOpacity>
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 20) + 20 }}
    >
      {/* Code card */}
      <View style={styles.codeCard}>
        <Text style={styles.codePre}>YOUR REFERRAL CODE</Text>
        <Text style={styles.code}>{stats?.referralCode ?? "—"}</Text>
        <TouchableOpacity style={styles.shareBtn} onPress={handleShare}>
          <Ionicons name="share-outline" size={18} color="white" />
          <Text style={styles.shareBtnText}>Share Your Code</Text>
        </TouchableOpacity>
      </View>

      {/* Stats */}
      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statNum}>{stats?.totalReferrals ?? 0}</Text>
          <Text style={styles.statLabel}>Total Referrals</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statNum}>{stats?.completedReferrals ?? 0}</Text>
          <Text style={styles.statLabel}>Completed</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statNum, { color: "#22c55e" }]}>{stats?.yearsEarned ?? 0}</Text>
          <Text style={styles.statLabel}>Years Earned</Text>
        </View>
      </View>

      {/* Progress to next free year */}
      <View style={styles.progressCard}>
        <View style={styles.progressHeader}>
          <Text style={styles.progressTitle}>Progress to Next Free Year</Text>
          <Text style={styles.progressFrac}>{progress} / {nextMilestone}</Text>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${(progress / nextMilestone) * 100}%` as any }]} />
        </View>
        <Text style={styles.progressSub}>
          {nextMilestone - progress} more referral{nextMilestone - progress === 1 ? "" : "s"} for a free year!
        </Text>
      </View>

      {/* How it works */}
      <Text style={styles.sectionTitle}>How It Works</Text>
      {[
        { step: "1", text: "Share your unique referral code with friends and family." },
        { step: "2", text: "When they sign up using your code and start their trial, it counts as a referral." },
        { step: "3", text: "Every 5 completed referrals earns you 1 free year of KKamera." },
        { step: "4", text: "There's no limit — 50 referrals = 10 free years!" },
      ].map(s => (
        <View key={s.step} style={styles.stepRow}>
          <View style={styles.stepNum}><Text style={styles.stepNumText}>{s.step}</Text></View>
          <Text style={styles.stepText}>{s.text}</Text>
        </View>
      ))}

      {/* Referrals list */}
      {referrals && referrals.length > 0 && (
        <>
          <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Recent Referrals</Text>
          {referrals.slice(0, 10).map(r => (
            <View key={r.id} style={styles.refRow}>
              <View style={styles.refAvatar}><Text style={styles.refAvatarText}>{r.referredName[0]?.toUpperCase()}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.refName}>{r.referredName}</Text>
                <Text style={styles.refDate}>{new Date(r.createdAt).toLocaleDateString()}</Text>
              </View>
              <View style={[styles.refBadge, r.status === "completed" && styles.refBadgeDone]}>
                <Text style={[styles.refBadgeText, r.status === "completed" && { color: "#22c55e" }]}>{r.status === "completed" ? "Counted" : "Pending"}</Text>
              </View>
            </View>
          ))}
        </>
      )}
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  center: { flex: 1, backgroundColor: BG, alignItems: "center", justifyContent: "center" },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  codeCard: { backgroundColor: "rgba(177,152,112,0.1)", borderRadius: 18, padding: 24, alignItems: "center", marginBottom: 16, borderWidth: 1, borderColor: "rgba(177,152,112,0.3)" },
  codePre: { fontSize: 10, color: "#888", fontFamily: "Inter_600SemiBold", letterSpacing: 2, marginBottom: 8 },
  code: { fontSize: 36, fontFamily: "Inter_700Bold", color: PRIMARY, letterSpacing: 4, marginBottom: 16 },
  shareBtn: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: PRIMARY, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  shareBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
  statsRow: { flexDirection: "row", gap: 10, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: CARD, borderRadius: 12, padding: 14, alignItems: "center", borderWidth: 1, borderColor: "rgba(177,152,112,0.1)" },
  statNum: { fontSize: 28, fontFamily: "Inter_700Bold", color: PRIMARY, marginBottom: 4 },
  statLabel: { fontSize: 11, color: "#888", fontFamily: "Inter_400Regular", textAlign: "center" },
  progressCard: { backgroundColor: CARD, borderRadius: 14, padding: 16, marginBottom: 24, borderWidth: 1, borderColor: "rgba(177,152,112,0.15)" },
  progressHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 10 },
  progressTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "white" },
  progressFrac: { fontSize: 14, fontFamily: "Inter_700Bold", color: PRIMARY },
  progressTrack: { height: 8, backgroundColor: "#2a2a2a", borderRadius: 4, marginBottom: 8, overflow: "hidden" },
  progressFill: { height: 8, backgroundColor: PRIMARY, borderRadius: 4 },
  progressSub: { fontSize: 12, color: "#888", fontFamily: "Inter_400Regular" },
  sectionTitle: { fontSize: 11, color: "#666", fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 14 },
  stepRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 12 },
  stepNum: { width: 28, height: 28, borderRadius: 14, backgroundColor: "rgba(177,152,112,0.15)", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  stepNumText: { fontSize: 13, fontFamily: "Inter_700Bold", color: PRIMARY },
  stepText: { flex: 1, fontSize: 14, color: "#ccc", fontFamily: "Inter_400Regular", lineHeight: 20, paddingTop: 4 },
  refRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.04)" },
  refAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(177,152,112,0.2)", alignItems: "center", justifyContent: "center" },
  refAvatarText: { fontSize: 15, fontFamily: "Inter_700Bold", color: PRIMARY },
  refName: { fontSize: 14, fontFamily: "Inter_500Medium", color: "white" },
  refDate: { fontSize: 11, color: "#666", fontFamily: "Inter_400Regular" },
  refBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: "rgba(107,114,128,0.15)" },
  refBadgeDone: { backgroundColor: "rgba(34,197,94,0.1)" },
  refBadgeText: { fontSize: 11, fontFamily: "Inter_500Medium", color: "#888" },
});
