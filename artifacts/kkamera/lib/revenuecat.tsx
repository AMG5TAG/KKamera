import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform } from "react-native";
import Purchases from "react-native-purchases";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import { getGetSubscriptionQueryKey, syncSubscription } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { useUpload } from "@/contexts/UploadContext";

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

/**
 * Detach this device's RevenueCat identity (Panic Wipe). Best-effort; resolves
 * even when RevenueCat isn't configured or is already anonymous.
 */
export async function logOutRevenueCat(): Promise<void> {
  if (Platform.OS === "web" || !_revenueCatReady) return;
  try {
    await Purchases.logOut();
  } catch { /* already anonymous — non-fatal */ }
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

/** The user backed out of the store sheet — not an error, show nothing. */
export function isPurchaseCancelled(err: unknown): boolean {
  const e = err as { code?: unknown; userCancelled?: unknown } | null | undefined;
  return !!e && (e.userCancelled === true || e.code === Purchases.PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR);
}

/**
 * A deferred purchase (Ask to Buy, or a pending payment method) — the store
 * accepted it but won't charge until it's approved, so it's neither a success
 * nor a failure yet.
 */
export function isPaymentPending(err: unknown): boolean {
  const e = err as { code?: unknown } | null | undefined;
  return !!e && e.code === Purchases.PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR;
}

function useSubscriptionContext() {
  const enabled = _revenueCatReady || Platform.OS === "web";
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { retryQueued } = useUpload();
  // The user id RevenueCat is currently logged in as. Purchases are only allowed
  // once this matches the signed-in user, so a purchase can never be made on an
  // anonymous RevenueCat id the server can't map back to an account.
  const [identifiedUserId, setIdentifiedUserId] = useState<number | null>(null);
  const identityReady = user?.id != null && identifiedUserId === user.id;
  // Live mirrors for the async logIn path below, which outlives renders.
  const userIdRef = useRef<number | null>(user?.id ?? null);
  userIdRef.current = user?.id ?? null;
  const identifiedRef = useRef<number | null>(null);
  const loginInFlight = useRef<Promise<boolean> | null>(null);

  // Ask the server to reconcile from RevenueCat (webhooks can lag or be missed),
  // then refetch the server subscription that gates uploads. Best effort — the
  // webhook remains the primary path. Resolves false when the sync call failed.
  const syncServerSubscription = useCallback(async (): Promise<boolean> => {
    let ok = true;
    try {
      await syncSubscription();
    } catch {
      // Sync unavailable / rate-limited — the webhook will still catch up.
      ok = false;
    } finally {
      await queryClient.invalidateQueries({ queryKey: getGetSubscriptionQueryKey() });
      // Captures parked on 402 only wake on foreground/network events; the wake
      // when the store sheet closes usually beats this sync and gets 402 again.
      retryQueued();
    }
    return ok;
  }, [queryClient, retryQueued]);

  // Only once Purchases.logIn has completed for THIS user (native): before
  // that, getCustomerInfo would return the previous/anonymous identity's
  // entitlements and cache them under this user's key.
  const customerInfoQuery = useQuery({
    queryKey: ["revenuecat", "customer-info", user?.id ?? null],
    queryFn: () => Purchases.getCustomerInfo(),
    staleTime: 60_000,
    enabled: enabled && (Platform.OS === "web" || identityReady),
    retry: false,
  });

  /**
   * Log RevenueCat in as the signed-in user (once; concurrent callers share
   * the attempt). Resolves true when RevenueCat is identified as that user.
   */
  const ensureIdentity = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === "web" || !_revenueCatReady) return false;
    const uid = userIdRef.current;
    if (uid == null) return false;
    if (identifiedRef.current === uid) return true;
    if (!loginInFlight.current) {
      loginInFlight.current = (async () => {
        try {
          await Purchases.logIn(String(uid));
          if (userIdRef.current !== uid) return false;
          identifiedRef.current = uid;
          setIdentifiedUserId(uid);
          // Pick up purchases already on this store account (reinstall, other
          // device, or a TRANSFER) without waiting for a webhook.
          void syncServerSubscription();
          void queryClient.invalidateQueries({ queryKey: ["revenuecat", "customer-info"] });
          return true;
        } catch {
          return false;
        } finally {
          loginInFlight.current = null;
        }
      })();
    }
    return loginInFlight.current;
  }, [syncServerSubscription, queryClient]);

  // Link RevenueCat purchases to the KKamera account (native only) so entitlements
  // follow the user across devices/reinstalls and the RevenueCat webhook can map
  // `app_user_id` back to our numeric userId. Without logIn, purchases are
  // anonymous per-device and the server can never reconcile them. A failed logIn
  // (offline at launch, RevenueCat hiccup) is retried with backoff and whenever
  // the app returns to the foreground, so purchases aren't blocked all session.
  useEffect(() => {
    if (Platform.OS === "web" || !_revenueCatReady) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    identifiedRef.current = null;
    setIdentifiedUserId(null);
    if (user?.id == null) {
      Purchases.logOut()
        .then(() => { if (!cancelled) customerInfoQuery.refetch(); })
        .catch(() => { /* already anonymous — non-fatal */ });
      return () => { cancelled = true; };
    }
    let attempt = 0;
    const run = async () => {
      if (cancelled || (await ensureIdentity()) || cancelled) return;
      if (attempt >= 6) return; // foreground / purchase / restore still retry
      timer = setTimeout(run, Math.min(60_000, 2_000 * 2 ** attempt++));
    };
    void run();
    const appSub = AppState.addEventListener("change", (st) => {
      if (st === "active" && !cancelled) void ensureIdentity();
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      appSub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const offeringsQuery = useQuery({
    queryKey: ["revenuecat", "offerings"],
    queryFn: () => Purchases.getOfferings(),
    staleTime: 300_000,
    enabled,
    // A transient failure must not read as "purchases unavailable" — retry a
    // couple of times; the subscription screen also refetches on focus.
    retry: 2,
  });

  const purchaseMutation = useMutation({
    mutationFn: async (packageToPurchase: any) => {
      if (!identityReady && !(await ensureIdentity())) {
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
    // Restore onto the signed-in user's RevenueCat id, never an anonymous one
    // the server can't map back to this account.
    mutationFn: async () => {
      if (!identityReady && !(await ensureIdentity())) {
        throw new Error("We're still linking your account to the store. Please wait a moment and try again.");
      }
      return Purchases.restorePurchases();
    },
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
    /** Plans couldn't be loaded (network / store hiccup) — distinct from purchases being unavailable on this build. */
    offeringsError: enabled && offeringsQuery.isError && !offeringsQuery.data,
    refetchOfferings: offeringsQuery.refetch,
    isOfferingsFetching: offeringsQuery.isFetching,
    /** Ask the server to reconcile from RevenueCat, then refetch the server subscription. */
    syncServerSubscription,
    isSubscribed,
    isReady: enabled,
    identityReady,
    isLoading: customerInfoQuery.isLoading || offeringsQuery.isLoading,
    purchase: purchaseMutation.mutateAsync,
    restore: restoreMutation.mutateAsync,
    isPurchasing: purchaseMutation.isPending,
    isRestoring: restoreMutation.isPending,
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
