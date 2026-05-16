import React from "react";
import { View, Text, StyleSheet, ScrollView, Platform, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

const BG = "#0d0b08";
const PRIMARY = "#b19870";

const EFFECTIVE_DATE = "13 May 2026";

export default function PrivacyScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
    <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
      <Ionicons name="chevron-back" size={24} color={PRIMARY} />
    </TouchableOpacity>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 20) + 20 }}>
      <Text style={styles.updated}>Effective: {EFFECTIVE_DATE}</Text>

      <Section title="1. Who We Are">
        KKamera ("we", "our", "us") provides a camera application that captures photos and videos and uploads them directly to your chosen cloud or storage destination. We are committed to protecting your privacy.
      </Section>

      <Section title="2. Information We Collect">
        <Bold>Account Information:</Bold> When you register, we collect your name, email address, and a hashed version of your password. We never store your password in plain text.{"\n\n"}
        <Bold>Usage Data:</Bold> We collect basic analytics such as app crash reports and feature usage to improve the app.{"\n\n"}
        <Bold>Upload Metadata:</Bold> We store metadata about your upload jobs (file name, file type, upload status) to manage the upload queue. We do not store the actual photo or video content on our servers.{"\n\n"}
        <Bold>Cloud Connection Credentials:</Bold> FTP/WebDAV passwords are stored encrypted using AES-256 encryption. OAuth tokens for Google Drive, OneDrive, and Dropbox are encrypted at rest.
      </Section>

      <Section title="3. How We Use Your Data">
        — To authenticate your account and maintain your session{"\n"}
        — To manage your subscription and process payments via Stripe{"\n"}
        — To manage your upload queue and retry failed uploads{"\n"}
        — To track referrals for the affiliate programme{"\n"}
        — To send you important account notifications (trial expiry, payment receipts)
      </Section>

      <Section title="4. Data We Do NOT Collect">
        We do not store your photos or videos. Your media goes directly from your device to your chosen cloud storage. We never see, access, or retain your actual photos or videos.
      </Section>

      <Section title="5. End-to-End Encryption">
        All data transferred between the KKamera app and our servers uses TLS 1.3 encryption. Sensitive credentials (cloud storage passwords, OAuth tokens) are encrypted using AES-256 before storage. Your media uploads are transmitted directly to your cloud provider — we do not act as an intermediary for media content.
      </Section>

      <Section title="6. Third-Party Services">
        <Bold>Stripe:</Bold> Payment processing. Stripe's privacy policy applies to payment data.{"\n"}
        <Bold>Google Drive / OneDrive / Dropbox:</Bold> These services receive your media directly. Their respective privacy policies apply.{"\n"}
        We do not sell your data to any third party.
      </Section>

      <Section title="7. Data Retention">
        Your account data is retained until you delete your account. Upload queue records are retained for 90 days. You can request deletion of all your data at any time by contacting us at privacy@kkamera.app.
      </Section>

      <Section title="8. Your Rights">
        Depending on your location, you may have the right to: access your personal data, correct inaccurate data, delete your data, port your data, and withdraw consent for processing. Contact us at privacy@kkamera.app to exercise these rights.
      </Section>

      <Section title="9. Children's Privacy">
        KKamera is not intended for children under 13. We do not knowingly collect data from children.
      </Section>

      <Section title="10. Contact">
        For privacy enquiries: privacy@kkamera.app
      </Section>
    </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.body}>{children}</Text>
    </View>
  );
}

function Bold({ children }: { children: React.ReactNode }) {
  return <Text style={styles.bold}>{children}</Text>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  updated: { fontSize: 12, color: "#666", fontFamily: "Inter_400Regular", marginBottom: 20, fontStyle: "italic" },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 14, fontFamily: "Inter_700Bold", color: PRIMARY, marginBottom: 8 },
  body: { fontSize: 14, color: "#ccc", fontFamily: "Inter_400Regular", lineHeight: 22 },
  bold: { fontFamily: "Inter_600SemiBold", color: "white" },
});
