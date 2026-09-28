import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Linking, Platform } from "react-native";
import Purchases from "react-native-purchases";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import { getGetSubscriptionQueryKey, syncSubscription } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";

const REVENUECAT_TEST_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY;
const REVENUECAT_IOS_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
const REVENUECAT_ANDROID_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;

export const REVENUECAT_ENTITLEMENT_IDENTIFIER = "pro";

// Tracks whether Purchases was successfully configured on this run
let _revenueCatReady = false;

function getRevenueCatApiKey(): string | null {
  if (Platform.OS === "web") return REVENUECAT_TEST_API_KEY ?? null;
  if (__DEV__ || Constants.executionEnvironment === "storeClient") {
    return REVENUECAT_TEST_API_KEY ?? null;
  }
  if (Platform.OS === "ios") return REVENUECAT_IOS_API_KEY ?? null;
  if (Platform.OS === "android") return REVENUECAT_ANDROID_API_KEY ?? null;
  return REVENUECAT_TEST_API_KEY ?? null;
}

export function initializeRevenueCat() {
  const apiKey = getRevenueCatApiKey();
  if (!apiKey) {
    return; // Purchases unavailable — no API key for this platform
  }
  try {
    Purchases.setLogLevel(Purchases.LOG_LEVEL.WARN);
    Purchases.configure({ apiKey });
    _revenueCatReady = true;
  } catch {
    // RevenueCat configure failed — purchases unavailable on this build
  }
}

const APP_STORE_SUBSCRIPTIONS_URL = "https://apps.apple.com/account/subscriptions";
const PLAY_SUBSCRIPTIONS_URL = "https://play.google.com/store/account/subscriptions";

/** Name of the store that bills this device's subscription, for user-facing copy. */
export const STORE_NAME = Platform.OS === "android" ? "Google Play" : "App Store";

/**
 * Opens the store's subscription management page, where the user cancels or
 * changes their KKamera subscription. Store subscriptions can only be cancelled
 * by the user in the store — deleting the account does not stop billing.
 */
export async function openManageSubscriptions(managementURL?: string | null): Promise<void> {
  if (Platform.OS === "ios" && _revenueCatReady) {
    try {
      await Purchases.showManageSubscriptions();
      return;
    } catch { /* fall through to the web URL */ }
  }
  const fallback = Platform.OS === "android" ? PLAY_SUBSCRIPTIONS_URL : APP_STORE_SUBSCRIPTIONS_URL;
  await Linking.openURL(managementURL || fallback);
}

function useSubscriptionContext() {
  const enabled = _revenueCatReady || Platform.OS === "web";
  const { user } = useAuth();
  const queryClient = useQueryClient();
  // The user id RevenueCat is currently logged in as. Purchases are only allowed
  // once this matches the signed-in user, so a purchase can never be made on an
  // anonymous RevenueCat id the server can't map back to an account.
  const [identifiedUserId, setIdentifiedUserId] = useState<number | null>(null);
  const identityReady = user?.id != null && identifiedUserId === user.id;

  // Ask the server to reconcile from RevenueCat (webhooks can lag or be missed),
  // then refetch the server subscription that gates uploads. Best effort — the
  // webhook remains the primary path.
  const syncServerSubscription = useCallback(async () => {
    try {
      await syncSubscription();
    } catch {
      // Sync unavailable / rate-limited — the webhook will still catch up.
    } finally {
      await queryClient.invalidateQueries({ queryKey: getGetSubscriptionQueryKey() });
    }
  }, [queryClient]);

  const customerInfoQuery = useQuery({
    queryKey: ["revenuecat", "customer-info", user?.id ?? null],
    queryFn: () => Purchases.getCustomerInfo(),
    staleTime: 60_000,
    enabled,
    retry: false,
  });

  // Link RevenueCat purchases to the KKamera account (native only) so entitlements
  // follow the user across devices/reinstalls and the RevenueCat webhook can map
  // `app_user_id` back to our numeric userId. Without logIn, purchases are
  // anonymous per-device and the server can never reconcile them.
  useEffect(() => {
    if (Platform.OS === "web" || !_revenueCatReady) return;
    let cancelled = false;
    setIdentifiedUserId(null);
    (async () => {
      try {
        if (user?.id != null) {
          await Purchases.logIn(String(user.id));
          if (cancelled) return;
          setIdentifiedUserId(user.id);
          // Pick up purchases already on this store account (reinstall, other
          // device, or a TRANSFER) without waiting for a webhook.
          syncServerSubscription();
        } else {
          await Purchases.logOut();
        }
        if (!cancelled) customerInfoQuery.refetch();
      } catch {
        // RevenueCat identity sync failed — entitlement checks fall back to
        // whatever the last-known customer info was; non-fatal.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const offeringsQuery = useQuery({
    queryKey: ["revenuecat", "offerings"],
    queryFn: () => Purchases.getOfferings(),
    staleTime: 300_000,
    enabled,
    retry: false,
  });

  const purchaseMutation = useMutation({
    mutationFn: async (packageToPurchase: any) => {
      if (!identityReady) {
        throw new Error("We're still linking your account to the store. Please wait a moment and try again.");
      }
      const { customerInfo } = await Purchases.purchasePackage(packageToPurchase);
      return customerInfo;
    },
    onSuccess: () => {
      customerInfoQuery.refetch();
      return syncServerSubscription();
    },
  });

  const restoreMutation = useMutation({
    mutationFn: () => Purchases.restorePurchases(),
    onSuccess: () => {
      customerInfoQuery.refetch();
      return syncServerSubscription();
    },
  });

  const isSubscribed =
    customerInfoQuery.data?.entitlements.active?.[REVENUECAT_ENTITLEMENT_IDENTIFIER] !== undefined;

  return {
    customerInfo: customerInfoQuery.data,
    offerings: offeringsQuery.data,
    isSubscribed,
    isReady: enabled,
    identityReady,
    isLoading: customerInfoQuery.isLoading || offeringsQuery.isLoading,
    purchase: purchaseMutation.mutateAsync,
    restore: restoreMutation.mutateAsync,
    isPurchasing: purchaseMutation.isPending,
    isRestoring: restoreMutation.isPending,
    purchaseError: purchaseMutation.error,
  };
}

type SubscriptionContextValue = ReturnType<typeof useSubscriptionContext>;
const Context = createContext<SubscriptionContextValue | null>(null);

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const value = useSubscriptionContext();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSubscription() {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useSubscription must be used within a SubscriptionProvider");
  return ctx;
}
