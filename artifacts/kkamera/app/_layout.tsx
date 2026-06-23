import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Head from "expo-router/head";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState, useCallback } from "react";
import { Alert, Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { setBaseUrl } from "@workspace/api-client-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { UploadProvider } from "@/contexts/UploadContext";
import { SettingsProvider, useSettings } from "@/contexts/SettingsContext";
import { SubscriptionProvider, initializeRevenueCat } from "@/lib/revenuecat";
import { API_BASE_URL } from "@/lib/config";
import LockScreen from "@/app/lock";

if (API_BASE_URL) {
  setBaseUrl(API_BASE_URL);
}

if (Platform.OS !== "web") {
  SplashScreen.preventAutoHideAsync().catch(() => {});
  initializeRevenueCat();
} else {
  SplashScreen.hideAsync().catch(() => {});
}

// ---------------------------------------------------------------------------
// PWA service worker + push subscription (web only)
// ---------------------------------------------------------------------------
async function registerPushSubscription(token: string) {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) return;

  try {
    // Fetch the server's VAPID public key
    const resp = await fetch(`${API_BASE_URL}/api/push/vapid-key`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return;
    const { publicKey } = await resp.json() as { publicKey: string };

    const reg = await navigator.serviceWorker.ready;

    // Check if already subscribed
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      // Convert base64url VAPID public key to Uint8Array
      const padding = "=".repeat((4 - (publicKey.length % 4)) % 4);
      const base64 = (publicKey + padding).replace(/-/g, "+").replace(/_/g, "/");
      const rawKey = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: rawKey,
      });
    }

    // Send subscription to server
    const subJson = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    await fetch(`${API_BASE_URL}/api/push/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        endpoint: subJson.endpoint,
        keys: subJson.keys,
      }),
    });
  } catch {
    // Push subscription is best-effort — ignore all errors
  }
}

async function registerServiceWorker(token: string | null) {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  try {
    await navigator.serviceWorker.register("/pwabuilder-sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;

    // Register periodic background sync
    const reg = await navigator.serviceWorker.ready;
    if ("periodicSync" in reg) {
      (reg as any).periodicSync
        .register("kkamera-periodic-upload", { minInterval: 15 * 60 * 1000 })
        .catch(() => {});
    }

    // Request push permission if we have a token
    if (token && "Notification" in window && Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      if (permission === "granted") {
        await registerPushSubscription(token);
      }
    } else if (token && "Notification" in window && Notification.permission === "granted") {
      await registerPushSubscription(token);
    }
  } catch {
    // SW registration is best-effort
  }
}

// ---------------------------------------------------------------------------
// App lock gate
// ---------------------------------------------------------------------------
function AppLockGate({ children }: { children: React.ReactNode }) {
  const { settings } = useSettings();
  const { isAuthenticated, logout } = useAuth();
  const [locked, setLocked] = useState(settings.appLockEnabled && isAuthenticated);

  // Re-lock when lock setting is enabled
  useEffect(() => {
    if (settings.appLockEnabled && isAuthenticated) setLocked(true);
  }, [settings.appLockEnabled, isAuthenticated]);

  // Unlock when user logs out
  useEffect(() => {
    if (!isAuthenticated) setLocked(false);
  }, [isAuthenticated]);

  if (locked) {
    return (
      <LockScreen
        onUnlock={() => setLocked(false)}
        onLogout={async () => { await logout(); setLocked(false); }}
      />
    );
  }
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Inner layout that has access to auth context for the token
// ---------------------------------------------------------------------------
function AppWithPush({ children }: { children: React.ReactNode }) {
  const { token, isAuthenticated } = useAuth();

  useEffect(() => {
    if (Platform.OS === "web") {
      registerServiceWorker(token);
    }
  }, [isAuthenticated, token]);

  return <>{children}</>;
}

// ---------------------------------------------------------------------------

const queryClient = new QueryClient();

function RootLayoutNav() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: "#0d0b08" },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="camera" options={{ headerShown: false }} />
      <Stack.Screen name="wizard" options={{ headerShown: false, presentation: "modal" }} />
      <Stack.Screen name="auth/login" options={{ headerShown: false }} />
      <Stack.Screen name="auth/register" options={{ headerShown: false }} />
      <Stack.Screen name="settings/index" options={{ title: "Settings" }} />
      <Stack.Screen name="settings/cloud" options={{ title: "Cloud Storage" }} />
      <Stack.Screen name="settings/add-cloud" options={{ title: "Add Connection" }} />
      <Stack.Screen name="settings/subscription" options={{ title: "Subscription" }} />
      <Stack.Screen name="settings/affiliate" options={{ title: "Refer & Earn" }} />
      <Stack.Screen name="settings/security" options={{ title: "Security (2FA)" }} />
      <Stack.Screen name="settings/feedback" options={{ title: "Feedback" }} />
      <Stack.Screen name="settings/privacy" options={{ title: "Privacy Policy" }} />
      <Stack.Screen name="settings/terms" options={{ title: "Terms of Service" }} />
      <Stack.Screen name="settings/privacy-security" options={{ headerShown: false }} />
      <Stack.Screen name="settings/delete-account" options={{ headerShown: false }} />
      <Stack.Screen name="auth/forgot-password" options={{ headerShown: false }} />
      <Stack.Screen name="auth/reset-password" options={{ headerShown: false }} />
      <Stack.Screen name="history" options={{ title: "Upload History" }} />
      <Stack.Screen name="markup" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded, fontError]);

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <SettingsProvider>
              <UploadProvider>
                <SubscriptionProvider>
                  <AppLockGate>
                  <AppWithPush>
                    {Platform.OS === "web" && (
                      <Head>
                        <meta charSet="utf-8" />
                        <meta name="viewport" content="width=device-width, initial-scale=1" />
                        <title>KKamera — Cloud-Based Camera App</title>
                        <meta name="description" content="KKamera is a subscription-based camera app for iOS, Android and web. Capture photos and videos and upload them directly to your cloud storage — no media left on your device." />
                        <meta name="keywords" content="camera app, cloud upload, photo upload, video upload, cloud photography, iOS camera, Android camera, PWA camera, Google Drive, Dropbox, OneDrive, WebDAV, FTP" />
                        <meta name="author" content="KKamera" />
                        <meta name="robots" content="index, follow" />
                        <link rel="canonical" href="https://app.kkamera.app/" />
                        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
                        <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
                        <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png" />
                        <link rel="shortcut icon" href="/favicon.ico" />
                        <meta name="apple-mobile-web-app-capable" content="yes" />
                        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
                        <meta name="apple-mobile-web-app-title" content="KKamera" />
                        <meta name="theme-color" content="#0d0b08" />
                        <meta name="rating" content="general" />
                        <meta property="og:type" content="website" />
                        <meta property="og:title" content="KKamera — Cloud-Based Camera App" />
                        <meta property="og:description" content="Capture photos and videos and upload them directly to your cloud storage. No media left on your device." />
                        <meta property="og:url" content="https://app.kkamera.app/" />
                        <meta property="og:image" content="https://app.kkamera.app/icons/icon-512.png" />
                        <meta property="og:site_name" content="KKamera" />
                        <meta name="twitter:card" content="summary_large_image" />
                        <meta name="twitter:title" content="KKamera — Cloud-Based Camera App" />
                        <meta name="twitter:description" content="Capture photos and videos and upload them directly to your cloud storage. No media left on your device." />
                        <meta name="twitter:image" content="https://app.kkamera.app/icons/icon-512.png" />
                      </Head>
                    )}
                    <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#0d0b08" }}>
                      <RootLayoutNav />
                    </GestureHandlerRootView>
                  </AppWithPush>
                  </AppLockGate>
                </SubscriptionProvider>
              </UploadProvider>
            </SettingsProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
