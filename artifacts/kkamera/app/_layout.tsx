import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, router } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, BackHandler, Keyboard, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { setBaseUrl } from "@workspace/api-client-react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { UploadProvider } from "@/contexts/UploadContext";
import { SettingsProvider, useSettings } from "@/contexts/SettingsContext";
import { SubscriptionProvider, initializeRevenueCat } from "@/lib/revenuecat";
import { API_BASE_URL } from "@/lib/config";
import LockScreen, { type LockSignOutReason } from "@/components/LockScreen";
import { isAuthPromptActive, RELOCK_GRACE_MS } from "@/lib/appLock";

if (API_BASE_URL) {
  setBaseUrl(API_BASE_URL);
}

SplashScreen.preventAutoHideAsync().catch(() => {});
initializeRevenueCat();

// ---------------------------------------------------------------------------
// App lock gate
//
// The lock screen is an absolutely-positioned overlay ABOVE the navigator — it
// never replaces it — so navigation state, in-progress markup, recordings and
// half-filled forms survive a lock/unlock cycle.
// ---------------------------------------------------------------------------

function AppLockGate({ children }: { children: React.ReactNode }) {
  const { settings, isLoading: settingsLoading, updateSetting } = useSettings();
  const { isAuthenticated, isLoading: authLoading, lastLoginAt, logout } = useAuth();
  const ready = !settingsLoading && !authLoading;
  const lockEnabled = settings.appLockEnabled && isAuthenticated;

  // null = not decided yet (settings/session still hydrating from storage).
  const [lockedState, setLockedState] = useState<boolean | null>(null);
  // Derive the initial decision synchronously during render, so the frame in
  // which hydration finishes already shows the lock — a deep-linked screen never
  // paints unlocked on a cold start. A session restored from storage (no
  // interactive sign-in in this process) with the lock enabled starts locked.
  const locked: boolean | null =
    lockedState !== null ? lockedState : ready ? lockEnabled && lastLoginAt === 0 : null;

  useEffect(() => {
    if (lockedState === null && locked !== null) setLockedState(locked);
  }, [lockedState, locked]);

  // Signing out always clears the lock (the login screen is the way back in).
  useEffect(() => {
    if (ready && !isAuthenticated) setLockedState(false);
  }, [ready, isAuthenticated]);

  // A successful password sign-in counts as an unlock. If the user was sent to
  // sign in because the lock had no usable credential (no PIN stored and no
  // biometrics/passcode on the device), turn the lock off so they aren't trapped
  // in a sign-in loop; they can set it up again in Privacy & Security.
  const disableLockOnNextLogin = useRef(false);
  const backgroundedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!lastLoginAt) return;
    setLockedState(false);
    backgroundedAt.current = null;
    if (disableLockOnNextLogin.current) {
      disableLockOnNextLogin.current = false;
      updateSetting("appLockEnabled", false);
      updateSetting("appLockType", "biometric");
    }
  }, [lastLoginAt, updateSetting]);

  // Re-lock only after a real trip to the background longer than the grace
  // period. `inactive` alone never re-locks, and a background transition caused
  // by our own device-auth prompt (Android's credential screen) is ignored.
  const lockEnabledRef = useRef(lockEnabled);
  useEffect(() => { lockEnabledRef.current = lockEnabled; }, [lockEnabled]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background") {
        if (backgroundedAt.current === null && !isAuthPromptActive()) {
          backgroundedAt.current = Date.now();
        }
      } else if (next === "active") {
        const since = backgroundedAt.current;
        backgroundedAt.current = null;
        if (since !== null && Date.now() - since >= RELOCK_GRACE_MS && lockEnabledRef.current) {
          Keyboard.dismiss();
          setLockedState(true);
        }
      }
    });
    return () => sub.remove();
  }, []);

  // Android hardware back must not navigate the stack hidden under the lock.
  useEffect(() => {
    if (!locked) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => sub.remove();
  }, [locked]);

  const handleUnlock = useCallback(() => setLockedState(false), []);

  const handleSignOut = useCallback(async (reason: LockSignOutReason) => {
    if (reason === "no-credential") disableLockOnNextLogin.current = true;
    await logout();
    setLockedState(false);
    router.replace("/auth/login");
  }, [logout]);

  return (
    <View style={styles.gateRoot}>
      <View
        style={styles.gateRoot}
        importantForAccessibility={locked === false ? "auto" : "no-hide-descendants"}
        accessibilityElementsHidden={locked !== false}
      >
        {children}
      </View>
      {locked === null && <View style={styles.cover} />}
      {locked === true && (
        <View style={styles.cover} accessibilityViewIsModal>
          <LockScreen onUnlock={handleUnlock} onSignOut={handleSignOut} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  gateRoot: { flex: 1, backgroundColor: "#0d0b08" },
  cover: { ...StyleSheet.absoluteFillObject, backgroundColor: "#0d0b08", zIndex: 1000, elevation: 1000 },
});

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
      {/* A card (not a native modal) so the app-lock overlay can cover it — a native
          modal is presented above the root view and would sit on top of the lock. */}
      <Stack.Screen name="wizard" options={{ headerShown: false, animation: "slide_from_bottom" }} />
      <Stack.Screen name="auth/login" options={{ headerShown: false }} />
      <Stack.Screen name="auth/register" options={{ headerShown: false }} />
      <Stack.Screen name="settings/index" options={{ title: "Settings" }} />
      <Stack.Screen name="settings/cloud" options={{ title: "Cloud Storage" }} />
      <Stack.Screen name="settings/upload-destinations" options={{ headerShown: false }} />
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
