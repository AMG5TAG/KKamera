import React from "react";
import { View, Text, StyleSheet, ScrollView, Platform, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { MailLink } from "@/components/MailLink";

const BG = "#0d0b08";
const PRIMARY = "#b19870";

const LAST_UPDATED = "28 September 2026";
const CONTACT = "development@koastal.com.au";

export default function PrivacyScreen() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
    <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
      <Ionicons name="chevron-back" size={24} color={PRIMARY} accessible={false} />
    </TouchableOpacity>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 20) + 20 }}>
      <Text style={styles.updated}>Last updated: {LAST_UPDATED}</Text>

      <Section title="1. Who we are">
        KKamera ("we", "our", "us") is a camera app that captures photos and videos and sends them to cloud storage or servers you choose. KKamera is provided by Koastal Kollective (www.koastal.com.au), based in Australia. This policy explains what information the app and our servers handle, why, and what choices you have.
      </Section>

      <Section title="2. How your photos and videos are handled">
        When you capture a photo or video, it is uploaded from your device to the KKamera server, which passes it on to the destinations you have selected (for example Google Drive, OneDrive, Dropbox, or your own FTP, WebDAV or Nextcloud server).{"\n\n"}
        While a file is being relayed it is written to temporary storage on our server and deleted once the transfer finishes (or fails). We do not keep copies of your photos or videos, and we do not view, analyse or use their content.{"\n\n"}
        On your device, captures are saved to your photo library if you allow it (KKamera only asks to add photos, not to read your library). Uploads waiting to be sent are kept in the app until they succeed. "Delete local file after upload" controls whether the app's own working copy is removed after a successful upload.
      </Section>

      <Section title="3. Information we store">
        <Bold>Account:</Bold> your name, email address and a bcrypt hash of your password (never the password itself). If you turn on two-factor authentication, we store your authenticator secret and hashed backup codes.{"\n\n"}
        <Bold>Cloud connections:</Bold> the details needed to reach each destination you add — for example server address, username, folder, and the password or OAuth access token for that service, plus the account name or email the provider reports. Passwords and tokens are encrypted with AES-256-GCM before they are stored.{"\n\n"}
        <Bold>Upload records:</Bold> for each upload, the file name, file type, status, any error message, which destinations it was sent to, and when. You can clear this history in the app.{"\n\n"}
        <Bold>Subscription:</Bold> your trial dates, subscription status and renewal date, as reported to us by RevenueCat.{"\n\n"}
        <Bold>Referrals:</Bold> who referred whom and whether the referral has completed. If you sign up with someone's referral code, they can see your name in their referral list.{"\n\n"}
        <Bold>Feedback:</Bold> the text and category of any feedback you send us from the app.{"\n\n"}
        <Bold>Security records:</Bold> hashed password-reset tokens, and a keyed hash of each email address that has used a free trial (see section 8).{"\n\n"}
        <Bold>Server logs:</Bold> like most online services, our server records technical request information (such as IP address, time and the endpoint called) to operate the service, limit abuse and investigate problems.
      </Section>

      <Section title="4. Location">
        If "Embed GPS in Photos" is on, KKamera reads your device's GPS location while the camera is open and writes the coordinates into the photo's metadata (EXIF). If you also turn on the "Date / Time / Location Stamp", the coordinates can appear printed on the image itself. That location travels with the file through our relay to your cloud destinations. We do not store your location separately or track it in the background. You can turn location off, or turn on "Strip EXIF" to remove metadata from photos, in the camera settings.
      </Section>

      <Section title="5. On your device only">
        App settings, the app-lock PIN (stored as a salted hash in your device's secure storage), and the offline upload queue stay on your device. Motion sensors are used only on the device for the level guide, compass heading and panorama capture. Face ID / fingerprint checks are performed by your device's operating system; KKamera never receives biometric data.
      </Section>

      <Section title="6. How we use information">
        — To create and secure your account, including sign-in and two-factor authentication{"\n"}
        — To relay your uploads to the destinations you choose and show you their status{"\n"}
        — To provide your free trial and check your subscription status{"\n"}
        — To run the referral programme{"\n"}
        — To send service emails: welcome, password reset, trial and subscription notices, referral rewards, and invites you ask us to send{"\n"}
        — To answer your feedback and support requests{"\n"}
        — To prevent abuse and keep the service secure{"\n\n"}
        We do not use your information for advertising, we do not include advertising, analytics or crash-reporting SDKs in the app, and we do not sell or rent your personal information.
      </Section>

      <Section title="7. Who we share information with">
        <Bold>Your chosen cloud providers</Bold> (Google, Microsoft, Dropbox, or the server you configure) receive the files you upload and use the credentials you connected. Their own privacy policies apply to what they store.{"\n\n"}
        <Bold>Apple App Store and Google Play</Bold> process subscription payments. We never see your card details.{"\n\n"}
        <Bold>RevenueCat</Bold> manages subscription status. It receives your KKamera account number (not your name or email) and purchase information from the store.{"\n\n"}
        <Bold>Resend</Bold> delivers our emails, so it processes the recipient address and message content.{"\n\n"}
        <Bold>Hosting:</Bold> our server and database run on Replit, which uses Google Cloud infrastructure. Your information may therefore be stored or processed outside Australia.{"\n\n"}
        <Bold>Witness mode:</Bold> if you turn it on, after each upload we email the address you enter with your name, the file name and the time. The file itself is not sent to the witness. Only add someone who has agreed to receive these emails.{"\n\n"}
        <Bold>Invites:</Bold> if you invite someone from the Refer & Earn screen, we email them your name and referral code. Their address is used only to send that email — we don't add it to our database, although it appears in our email delivery logs.{"\n\n"}
        We may also disclose information if required by law.
      </Section>

      <Section title="8. How long we keep it">
        We keep your account information for as long as your account exists. Upload records remain until you clear your upload history or delete your account (turning off "Record Upload History" only hides history in the app).{"\n\n"}
        When you delete your account in the app (Settings → Privacy & Security → Delete Account), we permanently delete your account, cloud connections and their stored credentials, upload records, feedback, subscription record, password-reset tokens and the referrals you made. If you were referred by someone and your referral had already earned them credit, that record is kept with your name replaced by "Deleted user".{"\n\n"}
        To prevent repeated free trials, we keep a keyed (one-way) hash of your email address after deletion. It cannot be turned back into your email address. Deleting your account does not cancel a store subscription — cancel it in your App Store or Google Play settings. Copies of files already delivered to your cloud storage are controlled by you and your provider.
      </Section>

      <Section title="9. Security">
        Connections between the app and our server use HTTPS. Cloud credentials are encrypted at rest, passwords are hashed, and sign-in, two-factor and other sensitive endpoints are rate-limited. No system is perfectly secure, so please use a strong password and turn on two-factor authentication.
      </Section>

      <Section title="10. Your choices and rights">
        In the app you can turn location and witness mode on or off, disconnect cloud accounts, clear your upload history and delete your account in the app. Depending on where you live (for example under the Australian Privacy Act, the GDPR or US state laws), you may also have rights to access, correct, delete or export your personal information, or to object to certain processing. Contact us at <MailLink address={CONTACT} subject="KKamera — privacy request" /> to make a request. If you are not satisfied with our response, you can complain to your local privacy regulator (in Australia, the OAIC).
      </Section>

      <Section title="11. Children">
        KKamera is not directed at children under 13 and we do not knowingly collect their personal information. If you believe a child has created an account, contact us and we will delete it.
      </Section>

      <Section title="12. Changes to this policy">
        If we make significant changes, we will update the date above and let you know in the app or by email.
      </Section>

      <Section title="13. Contact">
        Privacy questions and requests: <MailLink address={CONTACT} subject="KKamera — privacy enquiry" />
      </Section>
    </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} accessibilityRole="header">{title}</Text>
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
