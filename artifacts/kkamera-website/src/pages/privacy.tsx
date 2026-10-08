import { LegalPage, LegalSection as Section, B, MailLink } from "@/components/site-shell";

// Same text as the in-app policy (artifacts/kkamera/app/settings/privacy.tsx) —
// change both together.
const LAST_UPDATED = "28 September 2026";

export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy" updated={LAST_UPDATED}>
      <Section title="1. Who we are">
        <p>
          KKamera ("we", "our", "us") is a camera app that captures photos and videos and sends them to cloud storage or servers you choose. KKamera is provided by Koastal Kollective (www.koastal.com.au), based in Australia. This policy explains what information the app and our servers handle, why, and what choices you have.
        </p>
      </Section>

      <Section title="2. How your photos and videos are handled">
        <p>
          When you capture a photo or video, it is uploaded from your device to the KKamera server, which passes it on to the destinations you have selected (for example Google Drive, OneDrive, Dropbox, or your own FTP, WebDAV or Nextcloud server).
        </p>
        <p>
          While a file is being relayed it is written to temporary storage on our server and deleted once the transfer finishes (or fails). We do not keep copies of your photos or videos, and we do not view, analyse or use their content.
        </p>
        <p>
          On your device, captures are saved to your photo library if you allow it (KKamera only asks to add photos, not to read your library). Uploads waiting to be sent are kept in the app until they succeed. "Delete local file after upload" controls whether the app's own working copy is removed after a successful upload.
        </p>
      </Section>

      <Section title="3. Information we store">
        <p><B>Account:</B> your name, email address and a bcrypt hash of your password (never the password itself). If you turn on two-factor authentication, we store your authenticator secret and hashed backup codes.</p>
        <p><B>Cloud connections:</B> the details needed to reach each destination you add — for example server address, username, folder, and the password or OAuth access token for that service, plus the account name or email the provider reports. Passwords and tokens are encrypted with AES-256-GCM before they are stored.</p>
        <p><B>Upload records:</B> for each upload, the file name, file type, status, any error message, which destinations it was sent to, and when. You can clear this history in the app.</p>
        <p><B>Subscription:</B> your trial dates, subscription status and renewal date, as reported to us by RevenueCat.</p>
        <p><B>Referrals:</B> who referred whom and whether the referral has completed. If you sign up with someone's referral code, they can see your name in their referral list.</p>
        <p><B>Feedback:</B> the text and category of any feedback you send us from the app.</p>
        <p><B>Security records:</B> hashed password-reset tokens, and a keyed hash of each email address that has used a free trial (see section 8).</p>
        <p><B>Server logs:</B> like most online services, our server records technical request information (such as IP address, time and the endpoint called) to operate the service, limit abuse and investigate problems.</p>
      </Section>

      <Section title="4. Location">
        <p>
          If "Embed GPS in Photos" is on, KKamera reads your device's GPS location while the camera is open and writes the coordinates into the photo's metadata (EXIF). If you also turn on the "Date / Time / Location Stamp", the coordinates can appear printed on the image itself. That location travels with the file through our relay to your cloud destinations. We do not store your location separately or track it in the background. You can turn location off, or turn on "Strip EXIF" to remove metadata from photos, in the camera settings.
        </p>
      </Section>

      <Section title="5. On your device only">
        <p>
          App settings, the app-lock PIN (stored as a salted hash in your device's secure storage), and the offline upload queue stay on your device. Motion sensors are used only on the device for the level guide, compass heading and panorama capture. Face ID / fingerprint checks are performed by your device's operating system; KKamera never receives biometric data.
        </p>
      </Section>

      <Section title="6. How we use information">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>To create and secure your account, including sign-in and two-factor authentication</li>
          <li>To relay your uploads to the destinations you choose and show you their status</li>
          <li>To provide your free trial and check your subscription status</li>
          <li>To run the referral programme</li>
          <li>To send service emails: welcome, password reset, trial and subscription notices, referral rewards, and invites you ask us to send</li>
          <li>To answer your feedback and support requests</li>
          <li>To prevent abuse and keep the service secure</li>
        </ul>
        <p>
          We do not use your information for advertising, we do not include advertising, analytics or crash-reporting SDKs in the app, and we do not sell or rent your personal information.
        </p>
      </Section>

      <Section title="7. Who we share information with">
        <p><B>Your chosen cloud providers</B> (Google, Microsoft, Dropbox, or the server you configure) receive the files you upload and use the credentials you connected. Their own privacy policies apply to what they store.</p>
        <p><B>Apple App Store and Google Play</B> process subscription payments. We never see your card details.</p>
        <p><B>RevenueCat</B> manages subscription status. It receives your KKamera account number (not your name or email) and purchase information from the store.</p>
        <p><B>Resend</B> delivers our emails, so it processes the recipient address and message content.</p>
        <p><B>Hosting:</B> our server and database run on Replit, which uses Google Cloud infrastructure. Your information may therefore be stored or processed outside Australia.</p>
        <p><B>Witness mode:</B> if you turn it on, after each upload we email the address you enter with your name, the file name and the time. The file itself is not sent to the witness. Only add someone who has agreed to receive these emails.</p>
        <p><B>Invites:</B> if you invite someone from the Refer &amp; Earn screen, we email them your name and referral code. Their address is used only to send that email — we don't add it to our database, although it appears in our email delivery logs.</p>
        <p>We may also disclose information if required by law.</p>
      </Section>

      <Section title="8. How long we keep it">
        <p>
          We keep your account information for as long as your account exists. Upload records remain until you clear your upload history or delete your account (turning off "Record Upload History" only hides history in the app).
        </p>
        <p>
          When you delete your account in the app (Settings → Privacy &amp; Security → Delete Account), we permanently delete your account, cloud connections and their stored credentials, upload records, feedback, subscription record, password-reset tokens and the referrals you made. If you were referred by someone and your referral had already earned them credit, that record is kept with your name replaced by "Deleted user".
        </p>
        <p>
          To prevent repeated free trials, we keep a keyed (one-way) hash of your email address after deletion. It cannot be turned back into your email address. Deleting your account does not cancel a store subscription — cancel it in your App Store or Google Play settings. Copies of files already delivered to your cloud storage are controlled by you and your provider.
        </p>
      </Section>

      <Section title="9. Security">
        <p>
          Connections between the app and our server use HTTPS. Cloud credentials are encrypted at rest, passwords are hashed, and sign-in, two-factor and other sensitive endpoints are rate-limited. No system is perfectly secure, so please use a strong password and turn on two-factor authentication.
        </p>
      </Section>

      <Section title="10. Your choices and rights">
        <p>
          In the app you can turn location and witness mode on or off, disconnect cloud accounts, clear your upload history and delete your account in the app. Depending on where you live (for example under the Australian Privacy Act, the GDPR or US state laws), you may also have rights to access, correct, delete or export your personal information, or to object to certain processing. Contact us at <MailLink subject="KKamera — privacy request" /> to make a request. If you are not satisfied with our response, you can complain to your local privacy regulator (in Australia, the OAIC).
        </p>
      </Section>

      <Section title="11. Children">
        <p>
          KKamera is not directed at children under 13 and we do not knowingly collect their personal information. If you believe a child has created an account, contact us and we will delete it.
        </p>
      </Section>

      <Section title="12. Changes to this policy">
        <p>If we make significant changes, we will update the date above and let you know in the app or by email.</p>
      </Section>

      <Section title="13. Contact">
        <p>Privacy questions and requests: <MailLink subject="KKamera — privacy enquiry" /></p>
      </Section>
    </LegalPage>
  );
}
