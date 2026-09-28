import React from "react";
import { View, Text, StyleSheet, ScrollView, Platform, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useGetAffiliateStats, useGetReferrals } from "@workspace/api-client-react";
import { inviteLink, shareInvite } from "@/lib/shareInvite";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

/**
 * The server marks a referral "completed" when the friend's first paid
 * subscription starts, and "void" when that subscription is refunded or lapses.
 * "void" isn't in the generated ReferralStatus type yet, so compare as string.
 */
// Alert isn't implemented by react-native-web, so web feedback uses the browser dialog.
function notify(title: string, body: string) {
  if (Platform.OS === "web") window.alert(`${title}\n\n${body}`);
  else Alert.alert(title, body);
}

function referralStatusLabel(status: string): string {
  if (status === "completed") return "Counted";
  if (status === "void") return "Not counted";
  return "Pending";
}

export default function AffiliateScreen() {
  const insets = useSafeAreaInsets();
  const { data: stats, isLoading: statsLoading } = useGetAffiliateStats();
  const { data: referrals, isLoading: refLoading } = useGetReferrals();

  const progress = (stats?.completedReferrals ?? 0) % 5;
  const nextMilestone = 5;

  const referralLink = stats?.referralCode
    ? inviteLink(stats.referralCode)
    : null;

  const handleShare = async () => {
    if (!stats?.referralCode) return;
    const result = await shareInvite(stats.referralCode);
    if (result === "copied") {
      notify("Invite copied", "Your invite link and code are on the clipboard — paste them anywhere.");
    } else if (result === "unavailable") {
      notify("Share unavailable", `Sharing isn't supported here. Your referral code is ${stats.referralCode}.`);
    }
  };

  if (statsLoading) {
    return <View style={styles.center}><ActivityIndicator color={PRIMARY} accessibilityLabel="Loading" /></View>;
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
    <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
      <Ionicons name="chevron-back" size={24} color={PRIMARY} accessible={false} />
    </TouchableOpacity>
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 20) + 20 }}
    >
      {/* Code card */}
      <View style={styles.codeCard}>
        <Text style={styles.codePre}>YOUR REFERRAL CODE</Text>
        <Text style={styles.code}>{stats?.referralCode ?? "—"}</Text>
        {referralLink && (
          <View style={styles.linkRow}>
            <Ionicons name="link-outline" size={14} color="#888" accessible={false} />
            <Text style={styles.linkText} numberOfLines={1}>{referralLink}</Text>
          </View>
        )}
        <TouchableOpacity style={styles.shareBtn} onPress={handleShare} accessibilityRole="button">
          <Ionicons name="share-outline" size={18} color="white" accessible={false} />
          <Text style={styles.shareBtnText}>Share Link & Code</Text>
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
          <Text style={styles.statLabel}>Counted</Text>
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
        <View
          style={styles.progressTrack}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel="Progress to next free year"
          accessibilityValue={{ min: 0, max: nextMilestone, now: progress }}
        >
          <View style={[styles.progressFill, { width: `${(progress / nextMilestone) * 100}%` as any }]} />
        </View>
        <Text style={styles.progressSub}>
          {nextMilestone - progress} more referral{nextMilestone - progress === 1 ? "" : "s"} for a free year!
        </Text>
      </View>

      {/* How it works */}
      <Text style={styles.sectionTitle} accessibilityRole="header">How It Works</Text>
      {[
        { step: "1", text: "Share your unique referral code with friends and family." },
        { step: "2", text: "They sign up with your code and get a free 14-day trial." },
        { step: "3", text: "A referral counts when their first paid subscription starts — signups and trials alone don't count. Refunded or lapsed subscriptions aren't counted." },
        { step: "4", text: "Every 5 counted referrals earns you 1 free year of KKamera." },
        { step: "5", text: "There's no limit — 50 referrals = 10 free years!" },
      ].map(s => (
        <View key={s.step} style={styles.stepRow}>
          <View style={styles.stepNum}><Text style={styles.stepNumText}>{s.step}</Text></View>
          <Text style={styles.stepText}>{s.text}</Text>
        </View>
      ))}

      {/* Referrals list */}
      {referrals && referrals.length > 0 && (
        <>
          <Text style={[styles.sectionTitle, { marginTop: 24 }]} accessibilityRole="header">Recent Referrals</Text>
          {referrals.slice(0, 10).map(r => (
            <View key={r.id} style={styles.refRow}>
              <View style={styles.refAvatar}><Text style={styles.refAvatarText}>{r.referredName[0]?.toUpperCase()}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.refName}>{r.referredName}</Text>
                <Text style={styles.refDate}>{new Date(r.createdAt).toLocaleDateString()}</Text>
              </View>
              <View style={[styles.refBadge, r.status === "completed" && styles.refBadgeDone]}>
                <Text style={[styles.refBadgeText, r.status === "completed" && { color: "#22c55e" }]}>{referralStatusLabel(r.status)}</Text>
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
  linkRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 14, maxWidth: "100%" },
  linkText: { fontSize: 12, color: "#666", fontFamily: "Inter_400Regular", flex: 1 },
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
