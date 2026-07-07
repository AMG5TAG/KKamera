import React, { createContext, useContext, useEffect } from "react";
import { Platform } from "react-native";
import Purchases from "react-native-purchases";
import { useMutation, useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
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

function useSubscriptionContext() {
  const enabled = _revenueCatReady || Platform.OS === "web";
  const { user } = useAuth();

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
    (async () => {
      try {
        if (user?.id != null) {
          await Purchases.logIn(String(user.id));
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
      const { customerInfo } = await Purchases.purchasePackage(packageToPurchase);
      return customerInfo;
    },
    onSuccess: () => customerInfoQuery.refetch(),
  });

  const restoreMutation = useMutation({
    mutationFn: () => Purchases.restorePurchases(),
    onSuccess: () => customerInfoQuery.refetch(),
  });

  const isSubscribed =
    customerInfoQuery.data?.entitlements.active?.[REVENUECAT_ENTITLEMENT_IDENTIFIER] !== undefined;

  return {
    customerInfo: customerInfoQuery.data,
    offerings: offeringsQuery.data,
    isSubscribed,
    isReady: enabled,
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
