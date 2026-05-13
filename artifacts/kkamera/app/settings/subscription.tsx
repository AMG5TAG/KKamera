import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform, Alert, Linking } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSubscription, useCancelSubscription, useCreateCheckout,
  getGetSubscriptionQueryKey,
} from "@workspace/api-client-react";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

export default function SubscriptionScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { data: sub, isLoading } = useGetSubscription();
  const cancelMutation = useCancelSubscription();
  const checkoutMutation = useCreateCheckout();

  const status = sub?.status ?? "none";
  const trialEnd = sub?.trialEnd ? new Date(sub.trialEnd) : null;
  const daysLeft = trialEnd ? Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / 86400000)) : 0;

  const handleSubscribe = async () => {
    try {
      const result = await checkoutMutation.mutateAsync({});
      if (result.url) {
        Linking.openURL(result.url);
      }
    } catch {
      Alert.alert("Error", "Could not start checkout. Please try again.");
    }
  };

  const handleCancel = () => {
    Alert.alert("Cancel Subscription", "Are you sure? You'll lose access when your current period ends.", [
      { text: "Keep Subscription", style: "cancel" },
      {
        text: "Cancel", style: "destructive",
        onPress: async () => {
          await cancelMutation.mutateAsync({});
          queryClient.invalidateQueries({ queryKey: getGetSubscriptionQueryKey() });
        },
      },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 20) + 20 }}>
      {/* Status Card */}
      <View style={styles.statusCard}>
        {status === "trial" && (
          <>
            <View style={styles.statusBadge}><Text style={styles.statusBadgeText}>TRIAL</Text></View>
            <Text style={styles.statusTitle}>{daysLeft} days remaining</Text>
            <Text style={styles.statusSub}>Your free trial ends {trialEnd?.toLocaleDateString() ?? "soon"}</Text>
          </>
        )}
        {status === "active" && (
          <>
            <View style={[styles.statusBadge, { backgroundColor: "rgba(34,197,94,0.2)" }]}><Text style={[styles.statusBadgeText, { color: "#22c55e" }]}>ACTIVE</Text></View>
            <Text style={styles.statusTitle}>$25 / year</Text>
            <Text style={styles.statusSub}>Renews {sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : "—"}</Text>
          </>
        )}
        {(status === "none" || status === "cancelled" || status === "expired") && (
          <>
            <View style={[styles.statusBadge, { backgroundColor: "rgba(107,114,128,0.2)" }]}><Text style={[styles.statusBadgeText, { color: "#9ca3af" }]}>INACTIVE</Text></View>
            <Text style={styles.statusTitle}>No active subscription</Text>
            <Text style={styles.statusSub}>Subscribe to continue using KKamera</Text>
          </>
        )}
      </View>

      {/* Features */}
      <Text style={styles.sectionTitle}>What's included</Text>
      {[
        { icon: "infinite-outline", text: "Unlimited photo & video uploads" },
        { icon: "cloud-upload-outline", text: "Upload to multiple clouds simultaneously" },
        { icon: "lock-closed-outline", text: "End-to-end encrypted transfers" },
        { icon: "wifi-outline", text: "Offline queue — uploads when back online" },
        { icon: "people-outline", text: "Affiliate program — earn free years" },
        { icon: "film-outline", text: "4K video, slow motion, all formats" },
      ].map((f, i) => (
        <View key={i} style={styles.featureRow}>
          <Ionicons name={f.icon as any} size={18} color={PRIMARY} />
          <Text style={styles.featureText}>{f.text}</Text>
        </View>
      ))}

      {/* Pricing */}
      <View style={styles.priceCard}>
        <Text style={styles.priceAmount}>$25</Text>
        <Text style={styles.pricePer}>per year</Text>
        <Text style={styles.priceSub}>Less than 7¢ per day · Cancel anytime</Text>
      </View>

      {status === "trial" || status === "none" || status === "cancelled" || status === "expired" ? (
        <TouchableOpacity
          style={[styles.subscribeBtn, checkoutMutation.isPending && styles.btnDisabled]}
          onPress={handleSubscribe}
          disabled={checkoutMutation.isPending}
        >
          <Ionicons name="card-outline" size={18} color="white" />
          <Text style={styles.subscribeBtnText}>{checkoutMutation.isPending ? "Loading..." : "Subscribe Now — $25/year"}</Text>
        </TouchableOpacity>
      ) : null}

      {status === "active" && (
        <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
          <Text style={styles.cancelBtnText}>Cancel Subscription</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.footnote}>
        Payment is processed securely by Stripe. You'll be redirected to complete your purchase.
        Subscriptions auto-renew annually. Cancel anytime before renewal.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  statusCard: { backgroundColor: CARD, borderRadius: 16, padding: 20, alignItems: "center", marginBottom: 24, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)" },
  statusBadge: { backgroundColor: "rgba(177,152,112,0.2)", paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20, marginBottom: 10 },
  statusBadgeText: { fontSize: 11, fontFamily: "Inter_700Bold", color: PRIMARY, letterSpacing: 1.5 },
  statusTitle: { fontSize: 26, fontFamily: "Inter_700Bold", color: "white", marginBottom: 4 },
  statusSub: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular" },
  sectionTitle: { fontSize: 11, color: "#666", fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 14 },
  featureRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  featureText: { fontSize: 14, color: "#ccc", fontFamily: "Inter_400Regular" },
  priceCard: { backgroundColor: "rgba(177,152,112,0.08)", borderRadius: 16, padding: 20, alignItems: "center", marginVertical: 24, borderWidth: 1, borderColor: "rgba(177,152,112,0.25)" },
  priceAmount: { fontSize: 52, fontFamily: "Inter_700Bold", color: PRIMARY },
  pricePer: { fontSize: 16, color: "#888", fontFamily: "Inter_400Regular", marginTop: -4, marginBottom: 6 },
  priceSub: { fontSize: 13, color: "#666", fontFamily: "Inter_400Regular" },
  subscribeBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 16, marginBottom: 16 },
  btnDisabled: { opacity: 0.6 },
  subscribeBtnText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
  cancelBtn: { alignItems: "center", paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", marginBottom: 16 },
  cancelBtnText: { fontSize: 15, fontFamily: "Inter_500Medium", color: "#ef4444" },
  footnote: { fontSize: 12, color: "#555", fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 18 },
});
