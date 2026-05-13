import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  TextInput, Platform, Alert, Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useAuth } from "@/contexts/AuthContext";

const PRIMARY = "#b19870";
const SECONDARY = "#c3b091";
const BG = "#0d0b08";
const CARD = "#1a1710";

const STEPS = [
  { id: 0, title: "Welcome to KKamera", icon: "camera" },
  { id: 1, title: "Connect Your Storage", icon: "cloud-upload" },
  { id: 2, title: "Your 14-Day Trial", icon: "time" },
  { id: 3, title: "Refer & Earn Free Years", icon: "people" },
  { id: 4, title: "Secure Your Account", icon: "shield-checkmark" },
  { id: 5, title: "You're All Set!", icon: "checkmark-circle" },
];

const CLOUD_OPTIONS = [
  { type: "googledrive", label: "Google Drive", icon: "google-drive", color: "#4285F4", desc: "Connect via OAuth" },
  { type: "onedrive", label: "OneDrive", icon: "microsoft-onedrive", color: "#0078D4", desc: "Connect via OAuth" },
  { type: "dropbox", label: "Dropbox", icon: "dropbox", color: "#0061FF", desc: "Connect via OAuth" },
  { type: "webdav", label: "WebDAV", icon: "server", color: "#6B7280", desc: "Enter server details" },
  { type: "ftp", label: "FTP / SFTP", icon: "folder-network", color: "#8B5CF6", desc: "Enter FTP details" },
];

export default function WizardScreen() {
  const insets = useSafeAreaInsets();
  const { user, completeWizard } = useAuth();
  const [step, setStep] = useState(0);
  const [selectedStorage, setSelectedStorage] = useState<string | null>(null);

  const isLast = step === STEPS.length - 1;

  const goNext = () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isLast) {
      completeWizard().then(() => router.replace("/camera"));
    } else {
      setStep(s => Math.min(s + 1, STEPS.length - 1));
    }
  };

  const goBack = () => {
    if (step === 0) { router.back(); return; }
    setStep(s => Math.max(s - 1, 0));
  };

  const skipWizard = () => {
    completeWizard().then(() => router.replace("/camera"));
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        {step > 0 ? (
          <TouchableOpacity onPress={goBack} style={styles.headerBtn}>
            <Ionicons name="chevron-back" size={24} color={PRIMARY} />
          </TouchableOpacity>
        ) : <View style={styles.headerBtn} />}
        <View style={styles.progressDots}>
          {STEPS.map((_, i) => (
            <View key={i} style={[styles.dot, i === step && styles.dotActive, i < step && styles.dotDone]} />
          ))}
        </View>
        <TouchableOpacity onPress={skipWizard} style={styles.headerBtn}>
          <Text style={styles.skipText}>Skip</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentPad} showsVerticalScrollIndicator={false}>
        {/* Step icon */}
        <View style={styles.iconWrap}>
          <Ionicons name={(STEPS[step]?.icon ?? "camera") as any} size={56} color={PRIMARY} />
        </View>
        <Text style={styles.stepTitle}>{STEPS[step]?.title}</Text>

        {/* Step 0: Welcome */}
        {step === 0 && (
          <View>
            <Text style={styles.bodyText}>
              KKamera captures your photos and videos and instantly uploads them directly to your cloud or storage account — leaving no trace on your device.
            </Text>
            <InfoCard icon="cloud-done-outline" text="Zero storage used on your device — everything goes straight to the cloud." />
            <InfoCard icon="lock-closed-outline" text="End-to-end encrypted transfers keep your memories private." />
            <InfoCard icon="wifi-outline" text="Works offline — queues uploads until you're back online." />
            <InfoCard icon="shield-outline" text="No ads, no data mining. Just your photos, safely delivered." />
          </View>
        )}

        {/* Step 1: Connect Storage */}
        {step === 1 && (
          <View>
            <Text style={styles.bodyText}>
              Choose where your photos and videos will be saved. You can connect multiple accounts and upload to all of them simultaneously.
            </Text>
            {CLOUD_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.type}
                style={[styles.storageOption, selectedStorage === opt.type && styles.storageOptionSelected]}
                onPress={() => setSelectedStorage(opt.type)}
              >
                <MaterialCommunityIcons name={opt.icon as any} size={28} color={selectedStorage === opt.type ? PRIMARY : "#fff"} />
                <View style={styles.storageText}>
                  <Text style={styles.storageLabel}>{opt.label}</Text>
                  <Text style={styles.storageDesc}>{opt.desc}</Text>
                </View>
                {selectedStorage === opt.type && (
                  <Ionicons name="checkmark-circle" size={22} color={PRIMARY} />
                )}
              </TouchableOpacity>
            ))}
            <Text style={styles.footnote}>? You can add and manage multiple connections in Settings → Cloud Storage at any time.</Text>
          </View>
        )}

        {/* Step 2: Trial */}
        {step === 2 && (
          <View>
            <View style={styles.trialBadge}>
              <Text style={styles.trialDays}>14</Text>
              <Text style={styles.trialLabel}>Day Free Trial</Text>
            </View>
            <Text style={styles.bodyText}>
              Your 14-day free trial has already started. Enjoy full access to all KKamera features — no credit card required right now.
            </Text>
            <InfoCard icon="checkmark-circle-outline" text="Unlimited photo & video uploads during trial." />
            <InfoCard icon="calendar-outline" text="After 14 days: just $25/year to continue — less than 7¢ per day." />
            <InfoCard icon="notifications-outline" text="We'll remind you 3 days before your trial ends." />
            <InfoCard icon="close-circle-outline" text="Cancel anytime. No hidden fees, ever." />
          </View>
        )}

        {/* Step 3: Affiliate */}
        {step === 3 && (
          <View>
            <Text style={styles.bodyText}>
              Love KKamera? Share it and earn free subscription years — there's no limit on how many you can earn!
            </Text>
            <View style={styles.referralCard}>
              <Text style={styles.referralTitle}>Your Referral Code</Text>
              <Text style={styles.referralCode}>{user?.referralCode ?? "LOADING..."}</Text>
              <Text style={styles.referralSub}>Share this code. Tap to copy.</Text>
            </View>
            <InfoCard icon="people-outline" text="Every 5 friends who sign up with your code = 1 FREE year." />
            <InfoCard icon="infinite-outline" text="No limit — 25 referrals = 5 years free!" />
            <InfoCard icon="stats-chart-outline" text="Track your referrals in Settings → Refer & Earn." />
            <Text style={styles.footnote}>? Friends must complete signup and start their trial for the referral to count.</Text>
          </View>
        )}

        {/* Step 4: 2FA */}
        {step === 4 && (
          <View>
            <Text style={styles.bodyText}>
              Add an extra layer of security with Two-Factor Authentication. This is optional but highly recommended.
            </Text>
            <InfoCard icon="shield-checkmark-outline" text="2FA protects your account even if your password is compromised." />
            <InfoCard icon="phone-portrait-outline" text="Uses any authenticator app like Google Authenticator or Authy." />
            <InfoCard icon="key-outline" text="You'll receive backup codes to keep in a safe place." />
            <TouchableOpacity style={styles.setup2FABtn} onPress={() => router.push("/settings/security")}>
              <Ionicons name="shield-checkmark-outline" size={20} color="white" />
              <Text style={styles.setup2FAText}>Set Up 2FA Now (Optional)</Text>
            </TouchableOpacity>
            <Text style={styles.footnote}>? You can always set this up later in Settings → Security.</Text>
          </View>
        )}

        {/* Step 5: Done */}
        {step === 5 && (
          <View style={{ alignItems: "center" }}>
            <Text style={styles.bodyText}>
              You're all set! KKamera is ready to capture and protect your memories. Tap the shutter and your photos will be securely uploaded straight to your cloud storage.
            </Text>
            <InfoCard icon="camera-outline" text="Point, shoot, done — your photos are already in the cloud." />
            <InfoCard icon="help-circle-outline" text="Look for ? icons throughout the app for helpful tips." />
            <InfoCard icon="settings-outline" text="Customise camera formats, upload preferences and more in Settings." />
          </View>
        )}
      </ScrollView>

      {/* Footer */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <TouchableOpacity style={styles.nextBtn} onPress={goNext}>
          <Text style={styles.nextText}>{isLast ? "Start Using KKamera" : step === 4 ? "Skip 2FA for Now" : "Continue"}</Text>
          <Ionicons name="arrow-forward" size={18} color="white" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function InfoCard({ icon, text }: { icon: string; text: string }) {
  return (
    <View style={styles.infoCard}>
      <Ionicons name={icon as any} size={20} color={PRIMARY} />
      <Text style={styles.infoText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 12 },
  headerBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  progressDots: { flexDirection: "row", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#333" },
  dotActive: { backgroundColor: PRIMARY, width: 16 },
  dotDone: { backgroundColor: SECONDARY },
  skipText: { color: SECONDARY, fontSize: 14, fontFamily: "Inter_500Medium" },
  content: { flex: 1 },
  contentPad: { paddingHorizontal: 24, paddingBottom: 20 },
  iconWrap: { width: 96, height: 96, borderRadius: 48, backgroundColor: "rgba(177,152,112,0.12)", alignItems: "center", justifyContent: "center", alignSelf: "center", marginBottom: 20, borderWidth: 1, borderColor: "rgba(177,152,112,0.3)" },
  stepTitle: { fontSize: 26, fontFamily: "Inter_700Bold", color: "white", textAlign: "center", marginBottom: 16 },
  bodyText: { fontSize: 15, lineHeight: 22, color: "#ccc", fontFamily: "Inter_400Regular", textAlign: "center", marginBottom: 20 },
  infoCard: { flexDirection: "row", alignItems: "flex-start", gap: 12, backgroundColor: CARD, borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "rgba(177,152,112,0.15)" },
  infoText: { flex: 1, fontSize: 14, lineHeight: 20, color: "#ccc", fontFamily: "Inter_400Regular" },
  storageOption: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: CARD, borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "rgba(255,255,255,0.08)" },
  storageOptionSelected: { borderColor: PRIMARY, backgroundColor: "rgba(177,152,112,0.1)" },
  storageText: { flex: 1 },
  storageLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white", marginBottom: 2 },
  storageDesc: { fontSize: 12, color: "#888", fontFamily: "Inter_400Regular" },
  trialBadge: { alignSelf: "center", alignItems: "center", marginBottom: 20, backgroundColor: "rgba(177,152,112,0.15)", borderRadius: 20, paddingHorizontal: 32, paddingVertical: 20, borderWidth: 1, borderColor: PRIMARY },
  trialDays: { fontSize: 56, fontFamily: "Inter_700Bold", color: PRIMARY, lineHeight: 60 },
  trialLabel: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: SECONDARY },
  referralCard: { alignItems: "center", backgroundColor: CARD, borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: "rgba(177,152,112,0.3)" },
  referralTitle: { fontSize: 12, color: "#888", fontFamily: "Inter_500Medium", letterSpacing: 1, marginBottom: 8, textTransform: "uppercase" },
  referralCode: { fontSize: 32, fontFamily: "Inter_700Bold", color: PRIMARY, letterSpacing: 3, marginBottom: 6 },
  referralSub: { fontSize: 12, color: "#666", fontFamily: "Inter_400Regular" },
  setup2FABtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 14, marginVertical: 16 },
  setup2FAText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
  footnote: { fontSize: 12, color: "#666", fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 8, lineHeight: 18 },
  footer: { paddingHorizontal: 24, paddingTop: 12, backgroundColor: BG },
  nextBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: PRIMARY, borderRadius: 16, paddingVertical: 16 },
  nextText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
});
