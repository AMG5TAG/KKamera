import { type PropsWithChildren } from "react";
import { ScrollViewStyleReset } from "expo-router/html";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <title>KKamera — Cloud-Based Camera App</title>
        <meta name="description" content="KKamera is a subscription-based camera app for iOS, Android and web. Capture photos and videos and upload them directly to your cloud storage — no media left on your device." />
        <meta name="keywords" content="camera app, cloud upload, photo upload, video upload, cloud photography, iOS camera, Android camera, PWA camera, Google Drive, Dropbox, OneDrive, WebDAV, FTP" />
        <meta name="author" content="KKamera" />
        <meta name="robots" content="index, follow" />
        <link rel="canonical" href="https://kkamera.app/" />
        <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png" />
        <link rel="shortcut icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="KKamera" />
        <meta name="theme-color" content="#0d0b08" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="KKamera — Cloud-Based Camera App" />
        <meta property="og:description" content="Capture photos and videos and upload them directly to your cloud storage. No media left on your device." />
        <meta property="og:url" content="https://kkamera.app/" />
        <meta property="og:image" content="https://kkamera.app/icons/icon-512.png" />
        <meta property="og:site_name" content="KKamera" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="KKamera — Cloud-Based Camera App" />
        <meta name="twitter:description" content="Capture photos and videos and upload them directly to your cloud storage. No media left on your device." />
        <meta name="twitter:image" content="https://kkamera.app/icons/icon-512.png" />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
