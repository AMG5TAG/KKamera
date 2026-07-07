import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Platform, Modal, ActivityIndicator, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useGetSubscription } from "@workspace/api-client-react";
import { useSubscription } from "@/lib/revenuecat";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

const FEATURES = [
  { icon: "infinite-outline", text: "Unlimited photo & video uploads" },
  { icon: "cloud-upload-outline", text: "Upload to multiple clouds simultaneously" },
  { icon: "lock-closed-outline", text: "End-to-end encrypted transfers" },
  { icon: "wifi-outline", text: "Offline queue — uploads when back online" },
  { icon: "people-outline", text: "Affiliate program — earn free years" },
  { icon: "film-outline", text: "4K video, slow motion, all formats" },
];

export default function SubscriptionScreen() {
  const insets = useSafeAreaInsets();

  const { data: sub } = useGetSubscription();

  const rcSub = useSubscription();
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [confirmPackage, setConfirmPackage] = useState<any>(null);

  // RevenueCat is the source of truth for an active subscription.
  const isRcSubscribed = rcSub.isSubscribed;

  const status = sub?.status ?? "none";
  const trialEnd = sub?.trialEnd ? new Date(sub.trialEnd) : null;
  const daysLeft = trialEnd ? Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / 86400000)) : 0;

  const currentOffering = rcSub.offerings?.current;
  const annualPackage = currentOffering?.availablePackages.find(
    (p) => p.packageType === "ANNUAL" || p.identifier === "$rc_annual"
  ) ?? currentOffering?.availablePackages[0];
  const priceString = annualPackage?.product.priceString ?? "$25.00";

  const handleNativePurchase = () => {
    if (!annualPackage) return;
    setConfirmPackage(annualPackage);
    setConfirmVisible(true);
  };

  const confirmPurchase = async () => {
    setConfirmVisible(false);
    if (!confirmPackage) return;
    try {
      await rcSub.purchase(confirmPackage);
      // Successful payment → invite co-workers
      router.push("/invite?celebrate=1");
    } catch (err: any) {
      // User-cancelled isn't an error — stay silent. Anything else must be shown.
      if (!err?.userCancelled) {
        const rcErr: any = rcSub.purchaseError ?? err;
        const detail = typeof rcErr?.message === "string" && rcErr.message.length > 0 && rcErr.message.length < 160
          ? rcErr.message
          : "We couldn't complete your purchase. Please try again.";
        Alert.alert("Purchase Failed", detail);
      }
    }
  };

  const handleRestore = async () => {
    try {
      const info = await rcSub.restore();
      const hasActive = info?.entitlements?.active
        ? Object.keys(info.entitlements.active).length > 0
        : false;
      if (hasActive) {
        Alert.alert("Purchases Restored", "Your subscription is active again.");
      } else {
        Alert.alert("No Purchases Found", "We couldn't find an active subscription linked to your store account.");
      }
    } catch {
      Alert.alert("Restore Failed", "We couldn't restore your purchases. Please check your connection and try again.");
    }
  };

  const isPurchasing = rcSub.isPurchasing;

  const renderStatusCard = () => {
    if (isRcSubscribed) {
      const exp = rcSub.customerInfo?.entitlements.active?.["pro"]?.expirationDate;
      return (
        <View style={styles.statusCard}>
          <View style={[styles.statusBadge, { backgroundColor: "rgba(34,197,94,0.2)" }]}>
            <Text style={[styles.statusBadgeText, { color: "#22c55e" }]}>ACTIVE</Text>
          </View>
          <Text style={styles.statusTitle}>{priceString} / year</Text>
          {exp ? <Text style={styles.statusSub}>Renews {new Date(exp).toLocaleDateString()}</Text> : null}
        </View>
      );
    }
    if (status === "active") {
      return (
        <View style={styles.statusCard}>
          <View style={[styles.statusBadge, { backgroundColor: "rgba(34,197,94,0.2)" }]}>
            <Text style={[styles.statusBadgeText, { color: "#22c55e" }]}>ACTIVE</Text>
          </View>
          <Text style={styles.statusTitle}>$25 / year</Text>
          <Text style={styles.statusSub}>Renews {sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : "—"}</Text>
        </View>
      );
    }
    if (status === "trial") {
      return (
        <View style={styles.statusCard}>
          <View style={styles.statusBadge}>
            <Text style={styles.statusBadgeText}>TRIAL</Text>
          </View>
          <Text style={styles.statusTitle}>{daysLeft} days remaining</Text>
          <Text style={styles.statusSub}>Free trial ends {trialEnd?.toLocaleDateString() ?? "soon"}</Text>
        </View>
      );
    }
    return (
      <View style={styles.statusCard}>
        <View style={[styles.statusBadge, { backgroundColor: "rgba(107,114,128,0.2)" }]}>
          <Text style={[styles.statusBadgeText, { color: "#9ca3af" }]}>INACTIVE</Text>
        </View>
        <Text style={styles.statusTitle}>No active subscription</Text>
        <Text style={styles.statusSub}>Subscribe to continue using KKamera</Text>
      </View>
    );
  };

  const showSubscribeButton = !isRcSubscribed && (status === "none" || status === "trial" || status === "cancelled" || status === "expired");

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
    <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
      <Ionicons name="chevron-back" size={24} color={PRIMARY} />
    </TouchableOpacity>
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 20) + 20 }}
    >
      {renderStatusCard()}

      <Text style={styles.sectionTitle}>What's included</Text>
      {FEATURES.map((f, i) => (
        <View key={i} style={styles.featureRow}>
          <Ionicons name={f.icon as any} size={18} color={PRIMARY} />
          <Text style={styles.featureText}>{f.text}</Text>
        </View>
      ))}

      <View style={styles.priceCard}>
        <Text style={styles.priceAmount}>{priceString}</Text>
        <Text style={styles.pricePer}>per year</Text>
        <Text style={styles.priceSub}>Less than 7¢ per day · Cancel anytime</Text>
      </View>

      {showSubscribeButton && (
        <TouchableOpacity
          style={[styles.subscribeBtn, isPurchasing && styles.btnDisabled]}
          onPress={handleNativePurchase}
          disabled={isPurchasing}
        >
          {isPurchasing
            ? <ActivityIndicator color="white" />
            : <>
                <Ionicons name="bag-outline" size={18} color="white" />
                <Text style={styles.subscribeBtnText}>
                  {`Subscribe — ${priceString}/year`}
                </Text>
              </>
          }
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={[styles.restoreBtn, rcSub.isRestoring && styles.btnDisabled]}
        onPress={handleRestore}
        disabled={rcSub.isRestoring}
      >
        {rcSub.isRestoring
          ? <ActivityIndicator color={PRIMARY} size="small" />
          : <Text style={styles.restoreBtnText}>Restore Purchases</Text>
        }
      </TouchableOpacity>

      <Text style={styles.footnote}>
        Subscriptions are billed annually and auto-renew. Manage in your device's App Store settings.
      </Text>

      {/* Native purchase confirmation modal */}
      <Modal visible={confirmVisible} transparent animationType="fade" onRequestClose={() => setConfirmVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Confirm Purchase</Text>
            <Text style={styles.modalBody}>
              Subscribe to KKamera for {priceString}/year?{"\n\n"}
              This will be charged to your {Platform.OS === "ios" ? "Apple ID" : "Google Play"} account and auto-renews annually.
            </Text>
            <TouchableOpacity style={styles.modalConfirm} onPress={confirmPurchase}>
              <Text style={styles.modalConfirmText}>Subscribe — {priceString}/yr</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalCancel} onPress={() => setConfirmVisible(false)}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
    </View>
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
  subscribeBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 16, marginBottom: 10 },
  btnDisabled: { opacity: 0.6 },
  subscribeBtnText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
  restoreBtn: { alignItems: "center", paddingVertical: 12, marginBottom: 6 },
  restoreBtnText: { fontSize: 14, color: PRIMARY, fontFamily: "Inter_500Medium" },
  cancelBtn: { alignItems: "center", paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", marginBottom: 16 },
  cancelBtnText: { fontSize: 15, fontFamily: "Inter_500Medium", color: "#ef4444" },
  footnote: { fontSize: 12, color: "#555", fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 18 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.75)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: CARD, borderRadius: 20, padding: 24, width: "100%", maxWidth: 360, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)" },
  modalTitle: { fontSize: 20, fontFamily: "Inter_700Bold", color: "white", marginBottom: 12, textAlign: "center" },
  modalBody: { fontSize: 14, color: "#aaa", fontFamily: "Inter_400Regular", lineHeight: 22, textAlign: "center", marginBottom: 24 },
  modalConfirm: { backgroundColor: PRIMARY, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginBottom: 10 },
  modalConfirmText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
  modalCancel: { alignItems: "center", paddingVertical: 10 },
  modalCancelText: { fontSize: 14, color: "#666", fontFamily: "Inter_400Regular" },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
});
