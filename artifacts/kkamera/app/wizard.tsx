import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  TextInput, Platform, Alert, ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { useAuth } from "@/contexts/AuthContext";
import type { AuthUser } from "@/contexts/AuthContext";
import { useUpdateMe } from "@workspace/api-client-react";

const PRIMARY = "#b19870";
const SECONDARY = "#c3b091";
const BG = "#0d0b08";
const CARD = "#1a1710";

const STEPS = [
  { id: 0, title: "Your Profile", icon: "person" },
  { id: 1, title: "Connect Your Storage", icon: "cloud-upload" },
  { id: 2, title: "Allow Permissions", icon: "shield-checkmark" },
  { id: 3, title: "Your 14-Day Trial", icon: "time" },
  { id: 4, title: "Refer & Earn Free Years", icon: "people" },
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
  const { user, completeWizard, updateUser } = useAuth();
  const updateMeMutation = useUpdateMe();
  const [step, setStep] = useState(0);
  const [selectedStorage, setSelectedStorage] = useState<string | null>(null);
  const [profileName, setProfileName] = useState(user?.name ?? "");
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const isLast = step === STEPS.length - 1;

  const saveProfile = async () => {
    const trimmed = profileName.trim();
    if (!trimmed || trimmed === user?.name) return;
    setIsSavingProfile(true);
    try {
      const updated = await updateMeMutation.mutateAsync({ data: { name: trimmed } });
      updateUser(updated as AuthUser);
    } catch { /* ignore */ }
    setIsSavingProfile(false);
  };

  const goNext = async () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (step === 0) await saveProfile();
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

  const permissionGranted = (perm: { granted: boolean } | null) => perm?.granted === true;
  const cameraGranted = permissionGranted(cameraPermission);
  const micGranted = permissionGranted(micPermission);
  const allPermsGranted = cameraGranted && micGranted;

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
        <View style={styles.iconWrap}>
          <Ionicons name={(STEPS[step]?.icon ?? "camera") as any} size={56} color={PRIMARY} />
        </View>
        <Text style={styles.stepTitle}>{STEPS[step]?.title}</Text>

        {/* Step 0: Profile */}
        {step === 0 && (
          <View>
            <Text style={styles.bodyText}>
              Let's personalise your KKamera experience. What should we call you?
            </Text>
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>DISPLAY NAME</Text>
              <TextInput
                style={styles.input}
                value={profileName}
                onChangeText={setProfileName}
                placeholder="Your name"
                placeholderTextColor="#444"
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={goNext}
              />
            </View>
            <InfoCard icon="person-circle-outline" text="This is how you'll appear in KKamera and your referral code." />
            <InfoCard icon="lock-closed-outline" text="Your name is only visible to you — never shared with third parties." />
          </View>
        )}

        {/* Step 1: Cloud storage */}
        {step === 1 && (
          <View>
            <Text style={styles.bodyText}>
              Choose where your photos and videos will be saved. Connect multiple accounts to upload to all of them simultaneously.
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
                {selectedStorage === opt.type && <Ionicons name="checkmark-circle" size={22} color={PRIMARY} />}
              </TouchableOpacity>
            ))}
            <InfoCard icon="information-circle-outline" text="You can add and manage multiple connections in Settings → Upload at any time." />
          </View>
        )}

        {/* Step 2: Permissions */}
        {step === 2 && (
          <View>
            <Text style={styles.bodyText}>
              KKamera needs access to your camera and microphone to capture photos and videos.
            </Text>

            <PermRow
              icon="camera-outline"
              label="Camera"
              desc="Take photos and videos"
              granted={cameraGranted}
              onGrant={requestCameraPermission}
            />
            <PermRow
              icon="mic-outline"
              label="Microphone"
              desc="Record audio with videos"
              granted={micGranted}
              onGrant={requestMicPermission}
            />

            {allPermsGranted && (
              <View style={[styles.infoCard, { borderColor: "#22c55e33", backgroundColor: "rgba(34,197,94,0.06)" }]}>
                <Ionicons name="checkmark-circle" size={20} color="#22c55e" />
                <Text style={styles.infoText}>All permissions granted — you're ready to shoot!</Text>
              </View>
            )}
            {!allPermsGranted && (
              <InfoCard icon="information-circle-outline" text="You can grant these permissions later in your device Settings if you skip now." />
            )}
          </View>
        )}

        {/* Step 3: Trial */}
        {step === 3 && (
          <View>
            <View style={styles.trialBadge}>
              <Text style={styles.trialDays}>14</Text>
              <Text style={styles.trialLabel}>Day Free Trial</Text>
            </View>
            <Text style={styles.bodyText}>
              Your 14-day free trial has already started. Enjoy full access to all KKamera features — no credit card required right now.
            </Text>
            <InfoCard icon="checkmark-circle-outline" text="Unlimited photo & video uploads during your trial." />
            <InfoCard icon="calendar-outline" text="After 14 days: just $25/year to continue — less than 7¢ per day." />
            <InfoCard icon="notifications-outline" text="We'll remind you 3 days before your trial ends." />
            <InfoCard icon="close-circle-outline" text="Cancel anytime. No hidden fees, ever." />
          </View>
        )}

        {/* Step 4: Affiliate */}
        {step === 4 && (
          <View>
            <Text style={styles.bodyText}>
              Love KKamera? Share it and earn free subscription years — there's no limit on how many you can earn!
            </Text>
            <View style={styles.referralCard}>
              <Text style={styles.referralTitle}>Your Referral Code</Text>
              <Text style={styles.referralCode}>{user?.referralCode ?? "—"}</Text>
              <Text style={styles.referralSub}>Share this code with friends.</Text>
            </View>
            <InfoCard icon="people-outline" text="Every 5 friends who sign up with your code = 1 FREE year." />
            <InfoCard icon="infinite-outline" text="No limit — 25 referrals = 5 years free!" />
            <InfoCard icon="stats-chart-outline" text="Track your referrals in Settings → Subscription → Refer & Earn." />
          </View>
        )}

        {/* Step 5: Done */}
        {step === 5 && (
          <View style={{ alignItems: "center" }}>
            <Text style={styles.bodyText}>
              You're all set! KKamera is ready to capture and protect your memories. Tap the shutter and your photos will be securely uploaded straight to your cloud storage.
            </Text>
            <InfoCard icon="camera-outline" text="Point, shoot, done — your photos are already in the cloud." />
            <InfoCard icon="cloud-upload-outline" text="Tap the upload badge on the camera screen to view upload history." />
            <InfoCard icon="settings-outline" text="Customise camera formats, upload preferences and more in Settings." />
          </View>
        )}
      </ScrollView>

      {/* Footer */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <TouchableOpacity style={[styles.nextBtn, isSavingProfile && { opacity: 0.7 }]} onPress={goNext} disabled={isSavingProfile}>
          {isSavingProfile ? (
            <ActivityIndicator color="white" />
          ) : (
            <>
              <Text style={styles.nextText}>
                {isLast ? "Start Using KKamera" : step === 2 && !allPermsGranted ? "Continue Without Permissions" : "Continue"}
              </Text>
              <Ionicons name="arrow-forward" size={18} color="white" />
            </>
          )}
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

function PermRow({ icon, label, desc, granted, onGrant }: {
  icon: string; label: string; desc: string; granted: boolean; onGrant: () => void;
}) {
  return (
    <View style={styles.permRow}>
      <View style={styles.permIcon}>
        <Ionicons name={icon as any} size={22} color={granted ? "#22c55e" : PRIMARY} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.permLabel}>{label}</Text>
        <Text style={styles.permDesc}>{desc}</Text>
      </View>
      {granted ? (
        <View style={styles.permGrantedBadge}>
          <Ionicons name="checkmark" size={14} color="#22c55e" />
          <Text style={styles.permGrantedText}>Granted</Text>
        </View>
      ) : (
        <TouchableOpacity style={styles.permBtn} onPress={onGrant}>
          <Text style={styles.permBtnText}>Allow</Text>
        </TouchableOpacity>
      )}
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
  iconWrap: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: "rgba(177,152,112,0.12)", alignItems: "center", justifyContent: "center",
    alignSelf: "center", marginBottom: 20,
    borderWidth: 1, borderColor: "rgba(177,152,112,0.3)",
  },
  stepTitle: { fontSize: 26, fontFamily: "Inter_700Bold", color: "white", textAlign: "center", marginBottom: 16 },
  bodyText: { fontSize: 15, lineHeight: 22, color: "#ccc", fontFamily: "Inter_400Regular", textAlign: "center", marginBottom: 20 },
  inputGroup: { marginBottom: 16 },
  inputLabel: { fontSize: 11, color: "#666", fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, marginBottom: 8 },
  input: {
    backgroundColor: CARD, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14,
    fontSize: 17, fontFamily: "Inter_400Regular", color: "white",
    borderWidth: 1, borderColor: "rgba(177,152,112,0.25)",
  },
  infoCard: {
    flexDirection: "row", alignItems: "flex-start", gap: 12,
    backgroundColor: CARD, borderRadius: 12, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: "rgba(177,152,112,0.15)",
  },
  infoText: { flex: 1, fontSize: 14, lineHeight: 20, color: "#ccc", fontFamily: "Inter_400Regular" },
  storageOption: {
    flexDirection: "row", alignItems: "center", gap: 14,
    backgroundColor: CARD, borderRadius: 12, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.08)",
  },
  storageOptionSelected: { borderColor: PRIMARY, backgroundColor: "rgba(177,152,112,0.1)" },
  storageText: { flex: 1 },
  storageLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white", marginBottom: 2 },
  storageDesc: { fontSize: 12, color: "#888", fontFamily: "Inter_400Regular" },
  permRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: CARD, borderRadius: 14, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: "rgba(177,152,112,0.15)",
  },
  permIcon: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: "rgba(177,152,112,0.1)", alignItems: "center", justifyContent: "center",
  },
  permLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white", marginBottom: 2 },
  permDesc: { fontSize: 12, color: "#888", fontFamily: "Inter_400Regular" },
  permGrantedBadge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(34,197,94,0.12)", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20,
  },
  permGrantedText: { fontSize: 12, color: "#22c55e", fontFamily: "Inter_600SemiBold" },
  permBtn: { backgroundColor: PRIMARY, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  permBtnText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: "white" },
  trialBadge: {
    alignSelf: "center", alignItems: "center", marginBottom: 20,
    backgroundColor: "rgba(177,152,112,0.15)", borderRadius: 20,
    paddingHorizontal: 32, paddingVertical: 20, borderWidth: 1, borderColor: PRIMARY,
  },
  trialDays: { fontSize: 56, fontFamily: "Inter_700Bold", color: PRIMARY, lineHeight: 60 },
  trialLabel: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: SECONDARY },
  referralCard: {
    alignItems: "center", backgroundColor: CARD, borderRadius: 16,
    padding: 20, marginBottom: 16, borderWidth: 1, borderColor: "rgba(177,152,112,0.3)",
  },
  referralTitle: { fontSize: 12, color: "#888", fontFamily: "Inter_500Medium", letterSpacing: 1, marginBottom: 8, textTransform: "uppercase" },
  referralCode: { fontSize: 32, fontFamily: "Inter_700Bold", color: PRIMARY, letterSpacing: 3, marginBottom: 6 },
  referralSub: { fontSize: 12, color: "#666", fontFamily: "Inter_400Regular" },
  footer: { paddingHorizontal: 24, paddingTop: 12, backgroundColor: BG },
  nextBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10,
    backgroundColor: PRIMARY, borderRadius: 16, paddingVertical: 16,
    minHeight: 56,
  },
  nextText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
});
