import React, { useState } from "react";
import { trialTimeLeft } from "@/lib/trialTime";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Platform, Modal, ActivityIndicator, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useGetSubscription } from "@workspace/api-client-react";
import {
  STORE_NAME, isPaymentPending, isPurchaseCancelled, openManageSubscriptions, useSubscription,
} from "@/lib/revenuecat";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

// Only claims the app can actually back up — no unverifiable marketing copy.
const FEATURES = [
  { icon: "cloud-upload-outline", text: "Photos & videos upload directly to your own cloud" },
  { icon: "server-outline", text: "FTP / WebDAV / Nextcloud / Google Drive / OneDrive / Dropbox" },
  { icon: "git-branch-outline", text: "Upload to multiple destinations at once" },
  { icon: "wifi-outline", text: "Offline queue — uploads when back online" },
  { icon: "document-text-outline", text: "Document scanning" },
  { icon: "images-outline", text: "Panorama capture" },
];

type Period = { unit: string; adverb: string; length: string };

/** Billing period of a RevenueCat package, for the price and auto-renew disclosure. */
function periodOf(pkg: any): Period {
  const byType: Record<string, Period> = {
    ANNUAL: { unit: "year", adverb: "annually", length: "1 year" },
    SIX_MONTH: { unit: "6 months", adverb: "every 6 months", length: "6 months" },
    THREE_MONTH: { unit: "3 months", adverb: "every 3 months", length: "3 months" },
    TWO_MONTH: { unit: "2 months", adverb: "every 2 months", length: "2 months" },
    MONTHLY: { unit: "month", adverb: "monthly", length: "1 month" },
    WEEKLY: { unit: "week", adverb: "weekly", length: "1 week" },
  };
  if (pkg?.packageType && byType[pkg.packageType]) return byType[pkg.packageType];
  const iso: string | null | undefined = pkg?.product?.subscriptionPeriod;
  const m = iso ? /^P(\d+)([YMWD])$/.exec(iso) : null;
  if (m) {
    const n = Number(m[1]);
    const word = { Y: "year", M: "month", W: "week", D: "day" }[m[2] as "Y" | "M" | "W" | "D"];
    if (n === 1) return { unit: word, adverb: `every ${word}`, length: `1 ${word}` };
    return { unit: `${n} ${word}s`, adverb: `every ${n} ${word}s`, length: `${n} ${word}s` };
  }
  return byType.ANNUAL;
}

const fmtDate = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleDateString() : "—");

export default function SubscriptionScreen() {
  const insets = useSafeAreaInsets();

  const { data: sub } = useGetSubscription();

  const rcSub = useSubscription();
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [confirmPackage, setConfirmPackage] = useState<any>(null);

  // RevenueCat is the source of truth for an active subscription.
  const isRcSubscribed = rcSub.isSubscribed;
  const entitlement = rcSub.customerInfo?.entitlements.active?.["pro"];
  const managementURL = rcSub.customerInfo?.managementURL ?? null;

  const status = sub?.status ?? "none";
  const trialEnd = sub?.trialEnd ? new Date(sub.trialEnd) : null;
  const trialLeft = trialEnd ? trialTimeLeft(trialEnd) : null;
  const periodEnd = sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  const cancelledButActive = status === "cancelled" && !!periodEnd && periodEnd.getTime() > Date.now();

  const currentOffering = rcSub.offerings?.current;
  const annualPackage = currentOffering?.availablePackages.find(
    (p) => p.packageType === "ANNUAL" || p.identifier === "$rc_annual"
  ) ?? currentOffering?.availablePackages[0];
  // Never fall back to a hard-coded price: the store price is the only one we may show.
  const priceString: string | null = annualPackage?.product.priceString ?? null;
  const period = periodOf(annualPackage);
  const purchasesAvailable = rcSub.isReady && !!annualPackage;

  const openManage = () => {
    openManageSubscriptions(managementURL).catch(() => {
      Alert.alert("Couldn't open store", `Open your ${STORE_NAME} account settings to manage your subscription.`);
    });
  };

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
      // User-cancelled isn't an error — stay silent.
      if (isPurchaseCancelled(err)) return;
      // Ask to Buy / pending payment: nothing is charged or unlocked until the
      // store approves it; the entitlement arrives later via RevenueCat.
      if (isPaymentPending(err)) {
        Alert.alert(
          "Purchase pending approval",
          `Your purchase is waiting for approval in the ${STORE_NAME}. KKamera will unlock automatically once it's approved.`,
        );
        return;
      }
      const detail = typeof err?.message === "string" && err.message.length > 0 && err.message.length < 160
        ? err.message
        : "We couldn't complete your purchase. Please try again.";
      Alert.alert("Purchase Failed", detail);
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
  const priceLine = priceString ? `${priceString} / ${period.unit}` : "Subscribed";

  const Badge = ({ label, color, bg }: { label: string; color: string; bg: string }) => (
    <View style={[styles.statusBadge, { backgroundColor: bg }]}>
      <Text style={[styles.statusBadgeText, { color }]}>{label}</Text>
    </View>
  );

  const renderStatusCard = () => {
    const billingIssue = !!entitlement?.billingIssueDetectedAt || status === "past_due";
    if (billingIssue) {
      return (
        <View style={[styles.statusCard, { borderColor: "rgba(239,68,68,0.3)" }]}>
          <Badge label="BILLING PROBLEM" color="#ef4444" bg="rgba(239,68,68,0.15)" />
          <Text style={styles.statusTitle}>Payment failed</Text>
          <Text style={[styles.statusSub, { textAlign: "center" }]}>
            {STORE_NAME} couldn't charge your payment method. Update it in your {STORE_NAME} account to keep your subscription.
          </Text>
        </View>
      );
    }
    if (isRcSubscribed) {
      const exp = entitlement?.expirationDate;
      if (entitlement?.willRenew) {
        return (
          <View style={styles.statusCard}>
            <Badge label="ACTIVE" color="#22c55e" bg="rgba(34,197,94,0.2)" />
            <Text style={styles.statusTitle}>{priceLine}</Text>
            {exp ? <Text style={styles.statusSub}>Renews {fmtDate(exp)}</Text> : null}
          </View>
        );
      }
      return (
        <View style={styles.statusCard}>
          <Badge label="ACTIVE — DOESN'T RENEW" color="#22c55e" bg="rgba(34,197,94,0.2)" />
          <Text style={styles.statusTitle}>Active</Text>
          <Text style={styles.statusSub}>{exp ? `Access until ${fmtDate(exp)}` : "Auto-renew is off"}</Text>
        </View>
      );
    }
    if (cancelledButActive) {
      return (
        <View style={styles.statusCard}>
          <Badge label="ACTIVE — DOESN'T RENEW" color="#22c55e" bg="rgba(34,197,94,0.2)" />
          <Text style={styles.statusTitle}>Active</Text>
          <Text style={styles.statusSub}>Access until {fmtDate(periodEnd)}</Text>
        </View>
      );
    }
    if (status === "active") {
      // The server can't tell us whether the store will renew — only claim
      // "Renews" when RevenueCat says willRenew (handled above).
      return (
        <View style={styles.statusCard}>
          <Badge label="ACTIVE" color="#22c55e" bg="rgba(34,197,94,0.2)" />
          <Text style={styles.statusTitle}>{priceLine}</Text>
          <Text style={styles.statusSub}>Current period ends {fmtDate(periodEnd)}</Text>
        </View>
      );
    }
    if (status === "trial") {
      return (
        <View style={styles.statusCard}>
          <Badge label="TRIAL" color={PRIMARY} bg="rgba(177,152,112,0.2)" />
          <Text style={styles.statusTitle}>{trialLeft ? `${trialLeft.label} remaining` : "Trial active"}</Text>
          <Text style={styles.statusSub}>Free trial ends {trialEnd ? `${trialEnd.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} on ${trialEnd.toLocaleDateString()}` : "soon"}</Text>
        </View>
      );
    }
    return (
      <View style={styles.statusCard}>
        <Badge label={status === "cancelled" ? "CANCELLED" : status === "expired" ? "EXPIRED" : "INACTIVE"} color="#9ca3af" bg="rgba(107,114,128,0.2)" />
        <Text style={styles.statusTitle}>No active subscription</Text>
        <Text style={styles.statusSub}>Subscribe to continue using KKamera</Text>
      </View>
    );
  };

  const hasSubscription = isRcSubscribed || status === "active" || status === "past_due" || cancelledButActive;
  const showSubscribeButton = !hasSubscription;

  const disclosure = priceString
    ? `KKamera subscription: ${priceString} per ${period.unit}, billed ${period.adverb}. Subscription length: ${period.length}. `
    : "";

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
    <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
      <Ionicons name="chevron-back" size={24} color={PRIMARY} accessible={false} />
    </TouchableOpacity>
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 20) + 20 }}
    >
      {renderStatusCard()}

      {hasSubscription && (
        <TouchableOpacity style={styles.manageBtn} onPress={openManage} accessibilityRole="button">
          <Ionicons name="settings-outline" size={18} color={PRIMARY} accessible={false} />
          <Text style={styles.manageBtnText}>Manage Subscription</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.sectionTitle} accessibilityRole="header">What's included</Text>
      {FEATURES.map((f, i) => (
        <View key={i} style={styles.featureRow}>
          <Ionicons name={f.icon as any} size={18} color={PRIMARY} accessible={false} />
          <Text style={styles.featureText}>{f.text}</Text>
        </View>
      ))}

      {showSubscribeButton && (
        rcSub.isReady && rcSub.isLoading ? (
          <View style={styles.unavailableCard}>
            <ActivityIndicator color={PRIMARY} accessibilityLabel="Loading subscription options" />
          </View>
        ) : !purchasesAvailable ? (
          <View style={styles.unavailableCard}>
            <Ionicons name="alert-circle-outline" size={22} color="#9ca3af" accessible={false} />
            <Text style={styles.unavailableTitle}>Purchases unavailable on this build</Text>
            <Text style={styles.unavailableText}>
              In-app purchases can't be made here. Install KKamera from the {STORE_NAME} to subscribe, or use Restore Purchases if you've already subscribed.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.priceCard}>
              <Text style={styles.priceAmount}>{priceString}</Text>
              <Text style={styles.pricePer}>per {period.unit}</Text>
              <Text style={styles.priceSub}>Auto-renews {period.adverb} · Cancel anytime</Text>
            </View>

            {status === "trial" && (
              <Text style={styles.trialNote}>
                Your paid {period.unit} starts today; remaining trial days aren't carried over.
              </Text>
            )}

            <TouchableOpacity
              style={[styles.subscribeBtn, isPurchasing && styles.btnDisabled]}
              onPress={handleNativePurchase}
              disabled={isPurchasing}
              accessibilityRole="button"
              accessibilityLabel={isPurchasing ? "Purchasing" : `Subscribe, ${priceString} per ${period.unit}`}
              accessibilityState={{ disabled: isPurchasing, busy: isPurchasing }}
            >
              {isPurchasing
                ? <ActivityIndicator color="white" />
                : <>
                    <Ionicons name="bag-outline" size={18} color="white" accessible={false} />
                    <Text style={styles.subscribeBtnText}>
                      {`Subscribe — ${priceString}/${period.unit}`}
                    </Text>
                  </>
              }
            </TouchableOpacity>
          </>
        )
      )}

      <TouchableOpacity
        style={[styles.restoreBtn, rcSub.isRestoring && styles.btnDisabled]}
        onPress={handleRestore}
        disabled={rcSub.isRestoring}
        accessibilityRole="button"
        accessibilityLabel="Restore Purchases"
        accessibilityState={{ disabled: rcSub.isRestoring, busy: rcSub.isRestoring }}
      >
        {rcSub.isRestoring
          ? <ActivityIndicator color={PRIMARY} size="small" />
          : <Text style={styles.restoreBtnText}>Restore Purchases</Text>
        }
      </TouchableOpacity>

      <Text style={styles.footnote}>
        {disclosure}
        Payment is charged to your {STORE_NAME} account at confirmation of purchase. Subscription renews automatically unless cancelled at least 24 hours before the end of the current period. Manage or cancel in your {STORE_NAME} account settings.
      </Text>

      <View style={styles.legalRow}>
        <Text style={styles.legalLink} onPress={() => router.push("/settings/terms")} accessibilityRole="link">Terms of Use</Text>
        <Text style={styles.legalSep}>·</Text>
        <Text style={styles.legalLink} onPress={() => router.push("/settings/privacy")} accessibilityRole="link">Privacy Policy</Text>
      </View>

      <TouchableOpacity style={styles.referRow} onPress={() => router.push("/settings/affiliate")} accessibilityRole="button">
        <Ionicons name="people-outline" size={18} color={PRIMARY} accessible={false} />
        <View style={{ flex: 1 }}>
          <Text style={styles.referTitle}>Refer & Earn</Text>
          <Text style={styles.referSub}>Earn a free year for every 5 friends who subscribe</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color="#555" accessible={false} />
      </TouchableOpacity>

      {/* Native purchase confirmation modal */}
      <Modal visible={confirmVisible} transparent animationType="fade" onRequestClose={() => setConfirmVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle} accessibilityRole="header">Confirm Purchase</Text>
            <Text style={styles.modalBody}>
              Subscribe to KKamera for {priceString} per {period.unit}?{"\n\n"}
              {status === "trial" ? `Your paid ${period.unit} starts today; remaining trial days aren't carried over.\n\n` : ""}
              Payment is charged to your {STORE_NAME} account and renews automatically {period.adverb} unless cancelled at least 24 hours before the end of the current period.
            </Text>
            <TouchableOpacity style={styles.modalConfirm} onPress={confirmPurchase} accessibilityRole="button">
              <Text style={styles.modalConfirmText}>Subscribe — {priceString}/{period.unit}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalCancel} onPress={() => setConfirmVisible(false)} accessibilityRole="button">
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
  statusSub: { fontSize: 14, color: "#888", fontFamily: "Inter_400Regular", lineHeight: 20 },
  manageBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: "rgba(177,152,112,0.35)", marginTop: -12, marginBottom: 24 },
  manageBtnText: { fontSize: 15, fontFamily: "Inter_500Medium", color: PRIMARY },
  unavailableCard: { backgroundColor: CARD, borderRadius: 16, padding: 20, alignItems: "center", marginVertical: 24, gap: 8, borderWidth: 1, borderColor: "rgba(107,114,128,0.3)" },
  unavailableTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white", textAlign: "center" },
  unavailableText: { fontSize: 13, color: "#888", fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 19 },
  legalRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 12 },
  legalLink: { fontSize: 13, color: PRIMARY, fontFamily: "Inter_500Medium", textDecorationLine: "underline", paddingVertical: 6 },
  legalSep: { fontSize: 13, color: "#555" },
  referRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: CARD, borderRadius: 14, padding: 14, marginTop: 20, borderWidth: 1, borderColor: "rgba(177,152,112,0.15)" },
  referTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
  referSub: { fontSize: 12, color: "#888", fontFamily: "Inter_400Regular", marginTop: 2 },
  sectionTitle: { fontSize: 11, color: "#666", fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 14 },
  featureRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  featureText: { fontSize: 14, color: "#ccc", fontFamily: "Inter_400Regular" },
  priceCard: { backgroundColor: "rgba(177,152,112,0.08)", borderRadius: 16, padding: 20, alignItems: "center", marginVertical: 24, borderWidth: 1, borderColor: "rgba(177,152,112,0.25)" },
  priceAmount: { fontSize: 52, fontFamily: "Inter_700Bold", color: PRIMARY },
  pricePer: { fontSize: 16, color: "#888", fontFamily: "Inter_400Regular", marginTop: -4, marginBottom: 6 },
  priceSub: { fontSize: 13, color: "#666", fontFamily: "Inter_400Regular" },
  trialNote: { fontSize: 13, color: "#c3b091", fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 19, marginTop: -12, marginBottom: 14 },
  subscribeBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 16, marginBottom: 10 },
  btnDisabled: { opacity: 0.6 },
  subscribeBtnText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
  restoreBtn: { alignItems: "center", paddingVertical: 12, marginBottom: 6 },
  restoreBtnText: { fontSize: 14, color: PRIMARY, fontFamily: "Inter_500Medium" },
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
