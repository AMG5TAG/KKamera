// Static public legal pages (Privacy Policy, Terms of Use, Account deletion)
// required by the App Store and Google Play listings. Served by
// routes/legal.ts. All content is static — nothing user-supplied is
// interpolated — and pages are self-contained (inline styles, no scripts, no
// external assets) so they work under a strict CSP.
//
// The privacy and terms text is ported from the in-app screens
// (artifacts/kkamera/app/settings/privacy.tsx and terms.tsx). Keep them in sync:
// when one changes, change the other and bump LAST_UPDATED in both.

export const LAST_UPDATED = "29 October 2026";
export const CONTACT_EMAIL = "development@koastal.com.au";

function mailto(subject: string): string {
  return `<a href="mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}">${CONTACT_EMAIL}</a>`;
}

/** CSP for these pages: inline styles only, nothing else may load. */
export const LEGAL_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

type Section = { title: string; body: string };

function renderPage(title: string, intro: string, sections: Section[]): string {
  const body = sections
    .map((s) => `<section>\n<h2>${s.title}</h2>\n${s.body}\n</section>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · KKamera</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0d0b08; color: #ccc; font: 16px/1.6 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
         -webkit-text-size-adjust: 100%; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 20px 48px; }
  header { margin-bottom: 28px; }
  .brand { color: #c3b091; font-size: 14px; letter-spacing: .04em; text-transform: uppercase; margin: 0 0 6px; }
  h1 { color: #b19870; font-size: 28px; line-height: 1.25; margin: 0 0 8px; }
  .updated { color: #888; font-size: 13px; font-style: italic; margin: 0; }
  .intro { margin: 16px 0 0; }
  section { margin: 0 0 24px; }
  h2 { color: #b19870; font-size: 17px; margin: 0 0 8px; }
  p { margin: 0 0 12px; }
  ul, ol { margin: 0 0 12px; padding-left: 22px; }
  li { margin: 0 0 6px; }
  strong { color: #fff; font-weight: 600; }
  a { color: #c3b091; word-break: break-word; }
  nav { margin-top: 36px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,.08); font-size: 14px; }
  nav a { margin-right: 16px; }
  footer { color: #777; font-size: 13px; margin-top: 12px; }
</style>
</head>
<body>
<main>
<header>
<p class="brand">KKamera</p>
<h1>${title}</h1>
<p class="updated">Last updated: ${LAST_UPDATED}</p>
${intro ? `<p class="intro">${intro}</p>` : ""}
</header>
${body}
<nav><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Use</a><a href="/account-deletion">Delete your account</a></nav>
<footer>KKamera is provided by Koastal Kollective · <a href="https://www.koastal.com.au">www.koastal.com.au</a></footer>
</main>
</body>
</html>`;
}

// ─── Privacy Policy (ported from app/settings/privacy.tsx) ────────────────────

const PRIVACY_SECTIONS: Section[] = [
  {
    title: "1. Who we are",
    body: `<p>KKamera (&ldquo;we&rdquo;, &ldquo;our&rdquo;, &ldquo;us&rdquo;) is a camera app that captures photos and videos and sends them to cloud storage or servers you choose. KKamera is provided by Koastal Kollective (www.koastal.com.au), based in Australia. This policy explains what information the app and our servers handle, why, and what choices you have.</p>`,
  },
  {
    title: "2. How your photos and videos are handled",
    body: `<p>When you capture a photo or video, it is uploaded from your device to the KKamera server, which passes it on to the destinations you have selected (for example Google Drive, OneDrive, Dropbox, or your own FTP, WebDAV or Nextcloud server).</p>
<p>While a file is being relayed it is written to temporary storage on our server and deleted once the transfer finishes (or fails). We do not keep copies of your photos or videos, and we do not view, analyse or use their content.</p>
<p>On your device, captures are saved to your photo library if you allow it (KKamera only asks to add photos, not to read your library). Uploads waiting to be sent are kept in the app until they succeed. &ldquo;Delete local file after upload&rdquo; controls whether the app&rsquo;s own working copy is removed after a successful upload.</p>`,
  },
  {
    title: "3. Information we store",
    body: `<p><strong>Account:</strong> your name, email address and a bcrypt hash of your password (never the password itself). If you turn on two-factor authentication, we store your authenticator secret and hashed backup codes.</p>
<p><strong>Cloud connections:</strong> the details needed to reach each destination you add &mdash; for example server address, username, folder, and the password or OAuth access token for that service, plus the account name or email the provider reports. Passwords and tokens are encrypted with AES-256-GCM before they are stored.</p>
<p><strong>Upload records:</strong> for each upload, the file name, file type, status, any error message, which destinations it was sent to, and when. You can clear this history in the app.</p>
<p><strong>Subscription:</strong> your trial dates, subscription status and renewal date, as reported to us by RevenueCat.</p>
<p><strong>Referrals:</strong> who referred whom and whether the referral has completed. If you sign up with someone&rsquo;s referral code, they can see your name in their referral list.</p>
<p><strong>Feedback:</strong> the text and category of any feedback you send us from the app.</p>
<p><strong>Security records:</strong> hashed password-reset tokens, and a keyed hash of each email address that has used a free trial (see section 8).</p>
<p><strong>Server logs:</strong> like most online services, our server records technical request information (such as IP address, time and the endpoint called) to operate the service, limit abuse and investigate problems.</p>`,
  },
  {
    title: "4. Location",
    body: `<p>If &ldquo;Embed GPS in Photos&rdquo; is on, KKamera reads your device&rsquo;s GPS location while the camera is open and writes the coordinates into the photo&rsquo;s metadata (EXIF). If you also turn on the &ldquo;Date / Time / Location Stamp&rdquo;, the coordinates can appear printed on the image itself. That location travels with the file through our relay to your cloud destinations. We do not store your location separately or track it in the background. You can turn location off, or turn on &ldquo;Strip EXIF&rdquo; to remove metadata from photos, in the camera settings.</p>`,
  },
  {
    title: "5. On your device only",
    body: `<p>App settings, the app-lock PIN (stored as a salted hash in your device&rsquo;s secure storage), and the offline upload queue stay on your device. Motion sensors are used only on the device for the level guide, compass heading and panorama capture. Face ID / fingerprint checks are performed by your device&rsquo;s operating system; KKamera never receives biometric data.</p>`,
  },
  {
    title: "6. How we use information",
    body: `<ul>
<li>To create and secure your account, including sign-in and two-factor authentication</li>
<li>To relay your uploads to the destinations you choose and show you their status</li>
<li>To provide your free trial and check your subscription status</li>
<li>To run the referral programme</li>
<li>To send service emails: welcome, password reset, trial and subscription notices, referral rewards, and invites you ask us to send</li>
<li>To answer your feedback and support requests</li>
<li>To prevent abuse and keep the service secure</li>
</ul>
<p>We do not use your information for advertising, we do not include advertising or analytics SDKs in the app, and we do not sell or rent your personal information.</p>`,
  },
  {
    title: "7. Who we share information with",
    body: `<p><strong>Your chosen cloud providers</strong> (Google, Microsoft, Dropbox, or the server you configure) receive the files you upload and use the credentials you connected. Their own privacy policies apply to what they store.</p>
<p><strong>Apple App Store and Google Play</strong> process subscription payments. We never see your card details.</p>
<p><strong>RevenueCat</strong> manages subscription status. It receives your KKamera account number (not your name or email) and purchase information from the store.</p>
<p><strong>Resend</strong> delivers our emails, so it processes the recipient address and message content.</p>
<p><strong>Sentry</strong> receives crash and error reports from the app so we can fix problems: the error details, device model, operating system and app version, and your KKamera account number. Reports do not include your name, email, photos, videos or cloud credentials.</p>
<p><strong>Hosting:</strong> our server and database run on Replit, which uses Google Cloud infrastructure. Your information may therefore be stored or processed outside Australia.</p>
<p><strong>Witness mode:</strong> if you turn it on, after each upload we email the address you enter with your name, the file name and the time. The file itself is not sent to the witness. Only add someone who has agreed to receive these emails.</p>
<p><strong>Invites:</strong> if you invite someone from the Refer &amp; Earn screen, we email them your name and referral code. Their address is used only to send that email &mdash; we don&rsquo;t add it to our database, although it appears in our email delivery logs.</p>
<p>We may also disclose information if required by law.</p>`,
  },
  {
    title: "8. How long we keep it",
    body: `<p>We keep your account information for as long as your account exists. Upload records remain until you clear your upload history or delete your account (turning off &ldquo;Record Upload History&rdquo; only hides history in the app).</p>
<p>When you delete your account in the app (Settings &rarr; Privacy &amp; Security &rarr; Delete Account), we permanently delete your account, cloud connections and their stored credentials, upload records, feedback, subscription record, password-reset tokens and the referrals you made. If you were referred by someone and your referral had already earned them credit, that record is kept with your name replaced by &ldquo;Deleted user&rdquo;.</p>
<p>To prevent repeated free trials, we keep a keyed (one-way) hash of your email address after deletion. It cannot be turned back into your email address. Deleting your account does not cancel a store subscription &mdash; cancel it in your App Store or Google Play settings. Copies of files already delivered to your cloud storage are controlled by you and your provider.</p>
<p>See <a href="/account-deletion">how to delete your account</a>, including without the app.</p>`,
  },
  {
    title: "9. Security",
    body: `<p>Connections between the app and our server use HTTPS. Cloud credentials are encrypted at rest, passwords are hashed, and sign-in, two-factor and other sensitive endpoints are rate-limited. No system is perfectly secure, so please use a strong password and turn on two-factor authentication.</p>`,
  },
  {
    title: "10. Your choices and rights",
    body: `<p>In the app you can turn location and witness mode on or off, disconnect cloud accounts, clear your upload history and delete your account in the app. Depending on where you live (for example under the Australian Privacy Act, the GDPR or US state laws), you may also have rights to access, correct, delete or export your personal information, or to object to certain processing. Contact us at ${mailto("KKamera — privacy request")} to make a request. If you are not satisfied with our response, you can complain to your local privacy regulator (in Australia, the OAIC).</p>`,
  },
  {
    title: "11. Children",
    body: `<p>KKamera is not directed at children under 13 and we do not knowingly collect their personal information. If you believe a child has created an account, contact us and we will delete it.</p>`,
  },
  {
    title: "12. Changes to this policy",
    body: `<p>If we make significant changes, we will update the date above and let you know in the app or by email.</p>`,
  },
  {
    title: "13. Contact",
    body: `<p>Privacy questions and requests: ${mailto("KKamera — privacy enquiry")}</p>`,
  },
];

// ─── Terms of Use (ported from app/settings/terms.tsx) ────────────────────────

const TERMS_SECTIONS: Section[] = [
  {
    title: "1. About these terms",
    body: `<p>These terms apply to your use of the KKamera app and service (&ldquo;KKamera&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;), provided by Koastal Kollective (www.koastal.com.au). By creating an account or using KKamera you agree to them. If you don&rsquo;t agree, please don&rsquo;t use KKamera. Our <a href="/privacy">Privacy Policy</a> explains how we handle your information.</p>`,
  },
  {
    title: "2. What KKamera does",
    body: `<p>KKamera captures photos and videos on your device and uploads them, through our server, to the cloud storage accounts or servers you connect (such as Google Drive, OneDrive, Dropbox, FTP, WebDAV or Nextcloud). Our server passes files on and does not keep copies.</p>
<p>KKamera does not necessarily remove media from your device: captures can be saved to your photo library, and whether the app&rsquo;s working copy is deleted after upload depends on your settings. You are responsible for keeping your own backups.</p>`,
  },
  {
    title: "3. Your account",
    body: `<p>You need an account to use KKamera. Please give accurate details, keep your password secure, and tell us if you think your account has been misused. We recommend turning on two-factor authentication. You are responsible for activity on your account.</p>`,
  },
  {
    title: "4. Free trial and subscription",
    body: `<p><strong>Free trial:</strong> when you create an account, KKamera gives you a 14-day free trial with full access. No payment details are needed for the trial, and it is available once per email address.</p>
<p><strong>Subscription:</strong> after the trial, uploading requires a paid subscription, bought as an in-app purchase through the Apple App Store or Google Play. The price is shown in the app and in the store before you buy.</p>
<p><strong>Auto-renewal:</strong> subscriptions renew automatically at the end of each period and are charged to your store account unless you cancel at least 24 hours before the renewal date.</p>
<p><strong>Cancelling:</strong> manage or cancel your subscription in your App Store or Google Play account settings. Deleting the app or your KKamera account does not cancel it. After cancelling, you keep access until the end of the period you have paid for.</p>
<p><strong>Refunds:</strong> refunds are handled by Apple or Google under their policies, and nothing in these terms excludes rights you have under the Australian Consumer Law or other applicable consumer law.</p>
<p><strong>Price changes:</strong> if the price changes, Apple or Google will notify you as their rules require before the new price applies.</p>
<p><strong>Auto-renewing subscription details:</strong></p>
<ul>
<li>Subscription: KKamera annual subscription &mdash; full upload access for 1 year per period. The price for your country is shown in the app and the store before you confirm.</li>
<li>Payment is charged to your Apple ID or Google Play account when you confirm the purchase.</li>
<li>The subscription renews automatically for the same period and price unless auto-renew is turned off at least 24 hours before the end of the current period. Your account is charged for renewal within the 24 hours before the current period ends.</li>
<li>You can manage the subscription and turn off auto-renewal in your App Store account settings (Settings &rarr; [your name] &rarr; Subscriptions) or Google Play (Play Store &rarr; Payments &amp; subscriptions &rarr; Subscriptions) at any time after purchase.</li>
<li>If a store free-trial offer is shown at purchase, any unused portion of it is forfeited when you buy a subscription.</li>
</ul>`,
  },
  {
    title: "5. Referral programme",
    body: `<p>You can invite friends with your referral code. A referral counts when a friend who signed up with your code starts their first paid subscription. For every 5 referrals that count, we add one free year of KKamera access to your account.</p>
<p>We may void a referral &mdash; and remove free time it earned &mdash; if the friend&rsquo;s subscription is refunded, or if we reasonably believe the referral involves self-referral, fake or duplicate accounts, or other abuse. Referral rewards have no cash value and can&rsquo;t be transferred. A free year extends your KKamera access; it does not change billing for any store subscription you have, which you manage with Apple or Google. We may change or end the programme, but won&rsquo;t take away free years already earned fairly.</p>`,
  },
  {
    title: "6. Your content",
    body: `<p>Your photos and videos belong to you. You give us only the permission needed to receive your files and deliver them to the destinations you choose. Once delivered, files are stored by your chosen provider under their terms.</p>
<p>You are responsible for the credentials you connect, for having enough space in your storage accounts, and for checking that uploads have arrived where you expect.</p>`,
  },
  {
    title: "7. Using the camera and location responsibly",
    body: `<p>You must use KKamera lawfully and respect other people&rsquo;s privacy. In particular, you must not use it to record people covertly or without any consent the law requires, to capture or share illegal content, or to infringe anyone else&rsquo;s rights. Laws about photography, audio recording and location data vary by place &mdash; you are responsible for following those that apply to you.</p>
<p>Location embedding, photo stamps and witness notifications are optional features. Only turn them on when you are entitled to share that information, and only add a witness email address with that person&rsquo;s agreement.</p>`,
  },
  {
    title: "8. Service availability",
    body: `<p>We work to keep KKamera running reliably, but we can&rsquo;t promise it will always be available or error-free. Uploads also depend on your network, your devices and third-party services (such as your cloud providers and the app stores) that we don&rsquo;t control. We may change, suspend or discontinue features, and will give reasonable notice of significant changes where we can.</p>`,
  },
  {
    title: "9. Liability",
    body: `<p>Nothing in these terms excludes, restricts or modifies any guarantee, right or remedy you have under the Australian Consumer Law or other laws that cannot be excluded.</p>
<p>Subject to that, and to the extent the law allows: KKamera is provided &ldquo;as is&rdquo;; we are not liable for indirect or consequential loss, or for loss of data or content that was not delivered, was deleted from your device in line with your settings, or was lost by a third-party service; and our total liability to you is limited to the amount you paid for KKamera in the 12 months before the claim (or, where the law allows, to supplying the service again).</p>`,
  },
  {
    title: "10. Suspension and closing your account",
    body: `<p>You can delete your account at any time in Settings &rarr; Privacy &amp; Security &rarr; Delete Account (or <a href="/account-deletion">without the app</a>). We may suspend or close an account that seriously or repeatedly breaches these terms, that is used unlawfully, or where we are required to by law. Where reasonable, we will tell you first.</p>`,
  },
  {
    title: "11. Governing law",
    body: `<p>These terms are governed by the laws of New South Wales, Australia. Any disputes shall be subject to the exclusive jurisdiction of the courts of New South Wales and the courts entitled to hear appeals from them. This does not take away rights you have under the Australian Consumer Law or the consumer protection laws of the country where you live.</p>`,
  },
  {
    title: "12. Changes to these terms",
    body: `<p>We may update these terms. If a change is significant, we will tell you in the app or by email before it takes effect. If you keep using KKamera after that, the updated terms apply; if you don&rsquo;t agree, you can stop using KKamera and delete your account.</p>`,
  },
  {
    title: "13. App store terms",
    body: `<p>If you downloaded KKamera from the Apple App Store, Apple&rsquo;s <a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/">Licensed Application End User License Agreement</a> also applies, and Apple has no obligation to provide maintenance or support for KKamera. If you downloaded it from Google Play, the Google Play Terms of Service also apply. If anything in those terms conflicts with these terms, the store&rsquo;s terms apply to the extent of the conflict.</p>`,
  },
  {
    title: "14. Contact",
    body: `<p>Questions about these terms: ${mailto("KKamera — terms enquiry")}</p>`,
  },
];

// ─── Account deletion (derived from DELETE /api/users/me in routes/users.ts) ──

const DELETION_SECTIONS: Section[] = [
  {
    title: "Delete your account in the app",
    body: `<ol>
<li>Open KKamera and sign in.</li>
<li>Go to <strong>Settings &rarr; Privacy &amp; Security &rarr; Delete Account</strong>.</li>
<li>Confirm with your password (and your two-factor code or a backup code if two-factor authentication is on).</li>
</ol>
<p>Deletion happens immediately and cannot be undone.</p>`,
  },
  {
    title: "Delete your account without the app",
    body: `<p>Email ${mailto("KKamera — account deletion request")} <strong>from the email address registered to your KKamera account</strong> with the subject &ldquo;KKamera &mdash; account deletion request&rdquo;. We may ask you to confirm the request from that address before acting on it. We will delete the account within 30 days and confirm by email when it is done.</p>`,
  },
  {
    title: "What is deleted",
    body: `<ul>
<li>Your account: name, email address, password hash, and two-factor secret and backup codes</li>
<li>Your cloud connections and their encrypted passwords and access tokens</li>
<li>Your upload records (upload history)</li>
<li>Feedback you sent from the app</li>
<li>Your subscription record on our server</li>
<li>Password-reset tokens</li>
<li>Referrals you made, and any pending referral where you were the person referred</li>
</ul>
<p>Photos and videos are never stored on our server, so there are none to delete. Copies already delivered to your cloud storage are controlled by you and your provider, and media on your device is not affected.</p>`,
  },
  {
    title: "What is kept",
    body: `<ul>
<li><strong>A keyed one-way hash of your email address</strong>, kept to stop repeated free trials. It cannot be turned back into your email address.</li>
<li><strong>Completed referrals where you were the person referred</strong>, kept with your name replaced by &ldquo;Deleted user&rdquo;, so the person who referred you keeps the credit they earned.</li>
<li><strong>Server and email-delivery logs</strong> (technical request information, and delivery records of emails we sent you), kept for a limited period to operate and secure the service, then deleted.</li>
<li><strong>Purchase records held by Apple, Google and RevenueCat</strong>, which they keep under their own policies.</li>
</ul>`,
  },
  {
    title: "Cancel your subscription separately",
    body: `<p>Deleting your KKamera account (or the app) <strong>does not cancel a subscription</strong> bought through the App Store or Google Play. Cancel it yourself:</p>
<ul>
<li><strong>iPhone / iPad:</strong> Settings &rarr; [your name] &rarr; Subscriptions &rarr; KKamera &rarr; Cancel Subscription</li>
<li><strong>Android:</strong> Play Store &rarr; profile icon &rarr; Payments &amp; subscriptions &rarr; Subscriptions &rarr; KKamera &rarr; Cancel</li>
</ul>`,
  },
  {
    title: "Questions",
    body: `<p>Contact ${mailto("KKamera — account deletion")}. See also our <a href="/privacy">Privacy Policy</a>.</p>`,
  },
];

export const PRIVACY_HTML = renderPage("Privacy Policy", "", PRIVACY_SECTIONS);
export const TERMS_HTML = renderPage(
  "Terms of Use",
  "These terms are the end user licence agreement (EULA) for the KKamera app.",
  TERMS_SECTIONS,
);
export const ACCOUNT_DELETION_HTML = renderPage(
  "Delete your KKamera account",
  "You can delete your KKamera account and its data at any time, in the app or by email.",
  DELETION_SECTIONS,
);
