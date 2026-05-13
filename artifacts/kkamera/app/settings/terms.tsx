import React from "react";
import { View, Text, StyleSheet, ScrollView, Platform, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";

const BG = "#0d0b08";
const PRIMARY = "#b19870";

const EFFECTIVE_DATE = "13 May 2026";

export default function TermsScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.container}>
    <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
      <Ionicons name="chevron-back" size={24} color={PRIMARY} />
      <Text style={styles.backBtnText}>Back</Text>
    </TouchableOpacity>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 20) + 20 }}>
      <Text style={styles.updated}>Effective: {EFFECTIVE_DATE}</Text>

      <Section title="1. Acceptance of Terms">
        By downloading, installing, or using KKamera ("the App"), you agree to be bound by these Terms of Service. If you do not agree, do not use the App.
      </Section>

      <Section title="2. Description of Service">
        KKamera is a camera application that captures photos and videos on your device and uploads them directly to cloud storage accounts and/or servers you choose and configure. The App does not retain your media — it is uploaded to your chosen destination and deleted from the device.
      </Section>

      <Section title="3. Subscription and Pricing">
        <Bold>Free Trial:</Bold> New accounts receive a 14-day free trial with full access to all features. No credit card is required during the trial.{"\n\n"}
        <Bold>Paid Subscription:</Bold> After the trial period, continued use requires a subscription at $25 USD per year (or local equivalent). Subscriptions auto-renew annually.{"\n\n"}
        <Bold>Cancellation:</Bold> You may cancel at any time. Cancellation takes effect at the end of the current billing period. No refunds are provided for partial periods.{"\n\n"}
        <Bold>Price Changes:</Bold> We will notify you at least 30 days before any price change.
      </Section>

      <Section title="4. Affiliate Programme">
        Users may participate in the KKamera Affiliate Programme. For every 5 users who sign up using your referral code and complete their trial, you earn 1 free year of KKamera. There is no limit on free years earned. We reserve the right to modify or discontinue the affiliate programme with 30 days' notice. Fraudulent referrals (self-referrals, fake accounts) will result in account termination.
      </Section>

      <Section title="5. User Responsibilities">
        You are responsible for:{"\n"}
        — The security and accuracy of your cloud storage credentials{"\n"}
        — Ensuring you have rights to upload the content you capture{"\n"}
        — Complying with applicable local laws regarding photography and recording{"\n"}
        — Maintaining adequate storage space in your connected cloud accounts{"\n\n"}
        You must not use KKamera to capture or upload illegal content, including material that violates third-party rights or local law.
      </Section>

      <Section title="6. Data and Media">
        Your photos and videos are your property. We do not claim any rights over your media. By using the App, you authorise KKamera to transmit your media to the storage services you configure. We do not retain copies of your media on our servers.
      </Section>

      <Section title="7. Availability">
        We aim to maintain 99.9% uptime but cannot guarantee uninterrupted service. Scheduled maintenance will be announced in advance. We are not liable for any loss resulting from service interruptions.
      </Section>

      <Section title="8. Limitation of Liability">
        To the maximum extent permitted by law, KKamera shall not be liable for any indirect, incidental, special, or consequential damages, including loss of data, revenue, or profits. Our maximum liability is limited to the amount you paid in the 12 months preceding the claim.
      </Section>

      <Section title="9. Termination">
        We reserve the right to terminate or suspend accounts that violate these Terms. You may delete your account at any time through the App settings.
      </Section>

      <Section title="10. Governing Law">
        These Terms are governed by the laws of England and Wales. Any disputes shall be subject to the exclusive jurisdiction of the courts of England and Wales.
      </Section>

      <Section title="11. Changes to Terms">
        We may update these Terms from time to time. We will notify you of significant changes via email or in-app notification at least 14 days in advance. Continued use after notification constitutes acceptance.
      </Section>

      <Section title="12. Contact">
        For legal enquiries: legal@kkamera.app
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
  container: { flex: 1, backgroundColor: "#0d0b08" },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  backBtnText: { fontSize: 15, color: PRIMARY, fontFamily: "Inter_500Medium" },
  updated: { fontSize: 12, color: "#666", fontFamily: "Inter_400Regular", marginBottom: 20, fontStyle: "italic" },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 14, fontFamily: "Inter_700Bold", color: PRIMARY, marginBottom: 8 },
  body: { fontSize: 14, color: "#ccc", fontFamily: "Inter_400Regular", lineHeight: 22 },
  bold: { fontFamily: "Inter_600SemiBold", color: "white" },
});
