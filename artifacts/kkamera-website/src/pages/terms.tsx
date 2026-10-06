import { LegalPage, LegalSection as Section, B, MailLink } from "@/components/site-shell";

// Same text as the in-app terms (artifacts/kkamera/app/settings/terms.tsx) —
// change both together.
const LAST_UPDATED = "28 September 2026";

export default function Terms() {
  return (
    <LegalPage title="Terms of Service" updated={LAST_UPDATED}>
      <Section title="1. About these terms">
        <p>
          These terms apply to your use of the KKamera app and service ("KKamera", "we", "us"), provided by Koastal Kollective (www.koastal.com.au). By creating an account or using KKamera you agree to them. If you don't agree, please don't use KKamera. Our <a href="/privacy" className="text-primary hover:underline">Privacy Policy</a> explains how we handle your information.
        </p>
      </Section>

      <Section title="2. What KKamera does">
        <p>
          KKamera captures photos and videos on your device and uploads them, through our server, to the cloud storage accounts or servers you connect (such as Google Drive, OneDrive, Dropbox, FTP, WebDAV or Nextcloud). Our server passes files on and does not keep copies.
        </p>
        <p>
          KKamera does not necessarily remove media from your device: captures can be saved to your photo library, and whether the app's working copy is deleted after upload depends on your settings. You are responsible for keeping your own backups.
        </p>
      </Section>

      <Section title="3. Your account">
        <p>
          You need an account to use KKamera. Please give accurate details, keep your password secure, and tell us if you think your account has been misused. We recommend turning on two-factor authentication. You are responsible for activity on your account.
        </p>
      </Section>

      <Section title="4. Free trial and subscription">
        <p><B>Free trial:</B> when you create an account, KKamera gives you a 14-day free trial with full access. No payment details are needed for the trial, and it is available once per email address.</p>
        <p><B>Subscription:</B> after the trial, uploading requires a paid subscription, bought as an in-app purchase through the Apple App Store or Google Play. The price is shown in the app and in the store before you buy.</p>
        <p><B>Auto-renewal:</B> subscriptions renew automatically at the end of each period and are charged to your store account unless you cancel at least 24 hours before the renewal date.</p>
        <p><B>Cancelling:</B> manage or cancel your subscription in your App Store or Google Play account settings. Deleting the app or your KKamera account does not cancel it. After cancelling, you keep access until the end of the period you have paid for.</p>
        <p><B>Refunds:</B> refunds are handled by Apple or Google under their policies, and nothing in these terms excludes rights you have under the Australian Consumer Law or other applicable consumer law.</p>
        <p><B>Price changes:</B> if the price changes, Apple or Google will notify you as their rules require before the new price applies.</p>
      </Section>

      <Section title="5. Referral programme">
        <p>
          You can invite friends with your referral code. A referral counts when a friend who signed up with your code starts their first paid subscription. For every 5 referrals that count, we add one free year of KKamera access to your account.
        </p>
        <p>
          We may void a referral — and remove free time it earned — if the friend's subscription is refunded, or if we reasonably believe the referral involves self-referral, fake or duplicate accounts, or other abuse. Referral rewards have no cash value and can't be transferred. A free year extends your KKamera access; it does not change billing for any store subscription you have, which you manage with Apple or Google. We may change or end the programme, but won't take away free years already earned fairly.
        </p>
      </Section>

      <Section title="6. Your content">
        <p>
          Your photos and videos belong to you. You give us only the permission needed to receive your files and deliver them to the destinations you choose. Once delivered, files are stored by your chosen provider under their terms.
        </p>
        <p>
          You are responsible for the credentials you connect, for having enough space in your storage accounts, and for checking that uploads have arrived where you expect.
        </p>
      </Section>

      <Section title="7. Using the camera and location responsibly">
        <p>
          You must use KKamera lawfully and respect other people's privacy. In particular, you must not use it to record people covertly or without any consent the law requires, to capture or share illegal content, or to infringe anyone else's rights. Laws about photography, audio recording and location data vary by place — you are responsible for following those that apply to you.
        </p>
        <p>
          Location embedding, photo stamps and witness notifications are optional features. Only turn them on when you are entitled to share that information, and only add a witness email address with that person's agreement.
        </p>
      </Section>

      <Section title="8. Service availability">
        <p>
          We work to keep KKamera running reliably, but we can't promise it will always be available or error-free. Uploads also depend on your network, your devices and third-party services (such as your cloud providers and the app stores) that we don't control. We may change, suspend or discontinue features, and will give reasonable notice of significant changes where we can.
        </p>
      </Section>

      <Section title="9. Liability">
        <p>
          Nothing in these terms excludes, restricts or modifies any guarantee, right or remedy you have under the Australian Consumer Law or other laws that cannot be excluded.
        </p>
        <p>
          Subject to that, and to the extent the law allows: KKamera is provided "as is"; we are not liable for indirect or consequential loss, or for loss of data or content that was not delivered, was deleted from your device in line with your settings, or was lost by a third-party service; and our total liability to you is limited to the amount you paid for KKamera in the 12 months before the claim (or, where the law allows, to supplying the service again).
        </p>
      </Section>

      <Section title="10. Suspension and closing your account">
        <p>
          You can delete your account at any time in Settings → Privacy &amp; Security → Delete Account. We may suspend or close an account that seriously or repeatedly breaches these terms, that is used unlawfully, or where we are required to by law. Where reasonable, we will tell you first.
        </p>
      </Section>

      <Section title="11. Governing law">
        <p>
          These terms are governed by the laws of England and Wales. Any disputes shall be subject to the exclusive jurisdiction of the courts of England and Wales. This does not take away consumer protections you have under the laws of the country where you live.
        </p>
      </Section>

      <Section title="12. Changes to these terms">
        <p>
          We may update these terms. If a change is significant, we will tell you in the app or by email before it takes effect. If you keep using KKamera after that, the updated terms apply; if you don't agree, you can stop using KKamera and delete your account.
        </p>
      </Section>

      <Section title="13. Contact">
        <p>Questions about these terms: <MailLink subject="KKamera — terms enquiry" /></p>
      </Section>
    </LegalPage>
  );
}
