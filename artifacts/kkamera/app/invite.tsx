import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  TextInput, Platform, Share, ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { useGetAffiliateStats, useInviteCoworkers } from "@workspace/api-client-react";

const PRIMARY = "#b19870";
const SECONDARY = "#c3b091";
const BG = "#0d0b08";
const CARD = "#1a1710";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BENEFITS = [
  { icon: "gift-outline", title: "Earn free years", text: "Every 5 co-workers who subscribe adds 1 free year to your plan — no limit." },
  { icon: "time-outline", title: "They start free", text: "Everyone you invite gets a full 14-day trial. No credit card needed." },
  { icon: "cloud-done-outline", title: "Same workflow, whole team", text: "Shots upload straight to each person's own cloud storage — nothing left on devices." },
];

/** Contact Picker API (Chrome on Android / PWA). Returns selected emails. */
async function pickFromContacts(): Promise<string[]> {
  const contacts = (navigator as any)?.contacts;
  if (!contacts?.select) return [];
  try {
    const picked = await contacts.select(["name", "email"], { multiple: true });
    return picked.flatMap((c: any) => (c.email ?? []) as string[]).filter(Boolean);
  } catch {
    return []; // user dismissed the picker
  }
}

export default function InviteScreen() {
  const insets = useSafeAreaInsets();
  const { celebrate } = useLocalSearchParams<{ celebrate?: string }>();
  const { data: stats } = useGetAffiliateStats();
  const inviteMutation = useInviteCoworkers();

  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sentCount, setSentCount] = useState<number | null>(null);

  const canPickContacts = Platform.OS === "web" && !!(navigator as any)?.contacts?.select;
  const referralCode = stats?.referralCode ?? "";
  const referralLink = referralCode ? `https://app.kkamera.app/register?ref=${referralCode}` : "";

  const addEmail = useCallback((raw: string) => {
    const e = raw.trim().toLowerCase();
    if (!e) return;
    if (!EMAIL_RE.test(e)) { setError(`"${raw.trim()}" doesn't look like an email address.`); return; }
    setError("");
    setEmails(prev => (prev.includes(e) || prev.length >= 10 ? prev : [...prev, e]));
    setDraft("");
  }, []);

  const handlePickContacts = async () => {
    const picked = await pickFromContacts();
    if (picked.length === 0) return;
    setError("");
    setEmails(prev => {
      const merged = [...prev];
      for (const e of picked.map(x => x.toLowerCase())) {
        if (!merged.includes(e) && merged.length < 10 && EMAIL_RE.test(e)) merged.push(e);
      }
      return merged;
    });
  };

  const handleSend = async () => {
    if (draft.trim()) { addEmail(draft); }
    const toSend = draft.trim() && EMAIL_RE.test(draft.trim().toLowerCase())
      ? [...new Set([...emails, draft.trim().toLowerCase()])]
      : emails;
    if (toSend.length === 0) { setError("Add at least one email address."); return; }
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setError("");
    try {
      await inviteMutation.mutateAsync({ data: { emails: toSend } });
      setSentCount(toSend.length);
      setEmails([]);
      setDraft("");
    } catch (e: any) {
      setError(e?.data?.message || "Could not send invites. Please try again.");
    }
  };

  const handleShareInstead = async () => {
    if (!referralCode) return;
    try {
      await Share.share({
        message: `Join me on KKamera — the privacy-first camera app that uploads photos & videos straight to your own cloud storage.\n\nSign up with my invite for a free 14-day trial:\n${referralLink}\n\nOr use code: ${referralCode}`,
      });
    } catch { /* user dismissed */ }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/camera"))}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={24} color={PRIMARY} />
        </TouchableOpacity>
        <Text style={styles.heading}>Invite Co-Workers</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {celebrate === "1" && (
          <View style={styles.celebrateCard}>
            <Ionicons name="checkmark-circle" size={22} color="#22c55e" />
            <View style={{ flex: 1 }}>
              <Text style={styles.celebrateTitle}>Payment successful — welcome aboard!</Text>
              <Text style={styles.celebrateText}>Know someone who'd love KKamera? Invite them and earn free years.</Text>
            </View>
          </View>
        )}

        {/* Benefits */}
        <Text style={styles.sectionTitle}>Why invite people?</Text>
        {BENEFITS.map((b, i) => (
          <View key={i} style={styles.benefitRow}>
            <View style={styles.benefitIcon}>
              <Ionicons name={b.icon as any} size={20} color={PRIMARY} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.benefitTitle}>{b.title}</Text>
              <Text style={styles.benefitText}>{b.text}</Text>
            </View>
          </View>
        ))}

        {/* Referral code */}
        <View style={styles.codeCard}>
          <Text style={styles.codeLabel}>YOUR REFERRAL CODE</Text>
          <Text style={styles.code}>{referralCode || "—"}</Text>
          <Text style={styles.codeSub}>Included automatically in every invite</Text>
        </View>

        {sentCount !== null && (
          <View style={styles.sentCard}>
            <Ionicons name="paper-plane" size={20} color="#22c55e" />
            <Text style={styles.sentText}>
              Invites sent to {sentCount} contact{sentCount !== 1 ? "s" : ""}! You'll see them in your affiliate dashboard once they sign up.
            </Text>
          </View>
        )}

        {/* Recipients */}
        <Text style={styles.sectionTitle}>Send invites by email</Text>

        {emails.length > 0 && (
          <View style={styles.chipWrap}>
            {emails.map(e => (
              <View key={e} style={styles.chip}>
                <Text style={styles.chipText}>{e}</Text>
                <TouchableOpacity
                  onPress={() => setEmails(prev => prev.filter(x => x !== e))}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${e}`}
                >
                  <Ionicons name="close-circle" size={16} color="#888" />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder="coworker@company.com"
            placeholderTextColor="#555"
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => addEmail(draft)}
            returnKeyType="done"
          />
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => addEmail(draft)}
            accessibilityRole="button"
            accessibilityLabel="Add email"
          >
            <Ionicons name="add" size={22} color={PRIMARY} />
          </TouchableOpacity>
        </View>

        {canPickContacts && (
          <TouchableOpacity style={styles.contactsBtn} onPress={handlePickContacts}>
            <Ionicons name="people-outline" size={18} color={PRIMARY} />
            <Text style={styles.contactsBtnText}>Choose from Contacts</Text>
          </TouchableOpacity>
        )}

        {error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={16} color="#ef4444" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.sendBtn, (inviteMutation.isPending || (emails.length === 0 && !draft.trim())) && styles.btnDisabled]}
          onPress={handleSend}
          disabled={inviteMutation.isPending}
        >
          {inviteMutation.isPending
            ? <ActivityIndicator color="white" />
            : <>
                <Ionicons name="paper-plane-outline" size={18} color="white" />
                <Text style={styles.sendBtnText}>
                  Send Invite{emails.length > 1 ? `s (${emails.length})` : ""}
                </Text>
              </>
          }
        </TouchableOpacity>

        {/* Share-sheet fallback (SMS, WhatsApp, etc.) */}
        <TouchableOpacity style={styles.shareBtn} onPress={handleShareInstead}>
          <Ionicons name="share-outline" size={18} color={PRIMARY} />
          <Text style={styles.shareBtnText}>Share invite link another way</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.skipBtn} onPress={() => (router.canGoBack() ? router.back() : router.replace("/camera"))}>
          <Text style={styles.skipBtnText}>Maybe later</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  headerRow: { flexDirection: "row", alignItems: "center", minHeight: 52, paddingRight: 12 },
  backBtn: { padding: 12 },
  heading: { flex: 1, fontSize: 20, fontFamily: "Inter_700Bold", color: "white", textAlign: "center" },
  celebrateCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: "rgba(34,197,94,0.1)", borderRadius: 14, padding: 14, marginBottom: 24,
    borderWidth: 1, borderColor: "rgba(34,197,94,0.3)",
  },
  celebrateTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#22c55e", marginBottom: 2 },
  celebrateText: { fontSize: 13, color: "#999", fontFamily: "Inter_400Regular" },
  sectionTitle: { fontSize: 11, color: "#666", fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 14 },
  benefitRow: { flexDirection: "row", gap: 14, marginBottom: 16 },
  benefitIcon: {
    width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(177,152,112,0.12)", flexShrink: 0,
  },
  benefitTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white", marginBottom: 2 },
  benefitText: { fontSize: 13, color: "#999", fontFamily: "Inter_400Regular", lineHeight: 19 },
  codeCard: {
    backgroundColor: "rgba(177,152,112,0.08)", borderRadius: 16, padding: 18, alignItems: "center",
    marginVertical: 20, borderWidth: 1, borderColor: "rgba(177,152,112,0.25)",
  },
  codeLabel: { fontSize: 10, color: "#888", fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, marginBottom: 6 },
  code: { fontSize: 28, fontFamily: "Inter_700Bold", color: PRIMARY, letterSpacing: 3 },
  codeSub: { fontSize: 12, color: "#666", fontFamily: "Inter_400Regular", marginTop: 6 },
  sentCard: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "rgba(34,197,94,0.1)", borderRadius: 12, padding: 12, marginBottom: 20,
    borderWidth: 1, borderColor: "rgba(34,197,94,0.3)",
  },
  sentText: { flex: 1, fontSize: 13, color: "#22c55e", fontFamily: "Inter_500Medium", lineHeight: 18 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: CARD, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7,
    borderWidth: 1, borderColor: "rgba(177,152,112,0.25)",
  },
  chipText: { fontSize: 13, color: SECONDARY, fontFamily: "Inter_500Medium" },
  inputRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: CARD, borderRadius: 12, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)",
    paddingLeft: 16, paddingRight: 6, marginBottom: 10,
  },
  input: { flex: 1, paddingVertical: 14, color: "white", fontSize: 15, fontFamily: "Inter_400Regular" },
  addBtn: { padding: 8 },
  contactsBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: "rgba(177,152,112,0.35)", marginBottom: 10,
  },
  contactsBtnText: { fontSize: 14, color: PRIMARY, fontFamily: "Inter_500Medium" },
  errorBox: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "rgba(239,68,68,0.1)", borderRadius: 10, padding: 12, marginBottom: 10,
    borderWidth: 1, borderColor: "rgba(239,68,68,0.3)",
  },
  errorText: { flex: 1, color: "#ef4444", fontSize: 13, fontFamily: "Inter_400Regular" },
  sendBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 16, marginTop: 6, marginBottom: 10,
  },
  btnDisabled: { opacity: 0.6 },
  sendBtnText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
  shareBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: "rgba(177,152,112,0.35)", marginBottom: 6,
  },
  shareBtnText: { fontSize: 14, color: PRIMARY, fontFamily: "Inter_500Medium" },
  skipBtn: { alignItems: "center", paddingVertical: 12 },
  skipBtnText: { fontSize: 14, color: "#666", fontFamily: "Inter_400Regular" },
});
