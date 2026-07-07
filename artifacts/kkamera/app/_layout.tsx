import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
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

SplashScreen.preventAutoHideAsync().catch(() => {});
initializeRevenueCat();

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

  // Re-lock when the app returns to the foreground from background/inactive, so
  // "Require unlock on open" protects on resume — not just on a cold start.
  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      const prev = appState.current;
      appState.current = next;
      if (next === "active" && (prev === "background" || prev === "inactive")
        && settings.appLockEnabled && isAuthenticated) {
        setLocked(true);
      }
    });
    return () => sub.remove();
  }, [settings.appLockEnabled, isAuthenticated]);

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
      <Stack.Screen name="oauth-success" options={{ headerShown: false }} />
      <Stack.Screen name="oauth-error" options={{ headerShown: false }} />
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
                    <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#0d0b08" }}>
                      <RootLayoutNav />
                    </GestureHandlerRootView>
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
