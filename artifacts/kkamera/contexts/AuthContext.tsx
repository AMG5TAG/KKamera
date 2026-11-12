import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { setAuthTokenGetter, setUnauthorizedHandler, updateMe } from "@workspace/api-client-react";
import { setReportingUser } from "@/lib/errorReporting";
import { API_BASE_URL } from "@/lib/config";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  referralCode: string;
  twoFAEnabled: boolean;
  onboardingCompleted: boolean;
  createdAt: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  hasCompletedWizard: boolean;
  /**
   * Timestamp of the last interactive password sign-in in this app process (0 if
   * the session was restored from storage). The app-lock gate treats a sign-in
   * as an unlock.
   */
  lastLoginAt: number;
  login: (token: string, user: AuthUser) => Promise<void>;
  /**
   * Sign out: clears the stored session, the React Query cache and the
   * device-local wizard flag, then runs every `onLogout` listener.
   */
  logout: () => Promise<void>;
  /**
   * Register a callback run on every sign-out (e.g. to reset per-account device
   * settings such as the witness email). Returns an unsubscribe function.
   */
  onLogout: (listener: () => void) => () => void;
  /**
   * Report a 401 from a request made outside the generated API client (e.g. the
   * upload queue's XHR). `tokenUsed` is the bearer the request carried: the
   * session is only ended when that is still the current token, and never just
   * after an interactive sign-in (POST_LOGIN_401_GRACE_MS) — a stale in-flight
   * request must not sign out a NEW session.
   */
  reportUnauthorized: (tokenUsed?: string | null) => void;
  updateUser: (user: AuthUser) => void;
  completeWizard: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_KEY = "kkamera_token";
const USER_KEY = "kkamera_user";
const WIZARD_KEY = "kkamera_wizard_done";
/** Set once the stored token has been re-saved with SECURE_OPTS (see restore). */
const TOKEN_ACL_MIGRATED_KEY = "kkamera_token_acl_v2";

/**
 * Keychain class for the session token: readable only while the device is
 * unlocked, and never restored to another device from a backup. (Android's
 * Keystore-backed SecureStore ignores this option.)
 */
const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * A 401 arriving this soon after an interactive sign-in almost certainly belongs
 * to a request made with the PREVIOUS session's token (the unauthorized handler
 * isn't told which token a request used), so it must not sign the new session out.
 */
const POST_LOGIN_401_GRACE_MS = 5_000;

async function storeToken(token: string) {
  if (Platform.OS === "web") {
    await AsyncStorage.setItem(TOKEN_KEY, token);
  } else {
    // Delete first: updating an existing item may keep its old keychain class.
    await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
    await SecureStore.setItemAsync(TOKEN_KEY, token, SECURE_OPTS);
    await AsyncStorage.setItem(TOKEN_ACL_MIGRATED_KEY, "1").catch(() => {});
  }
}

async function getToken(): Promise<string | null> {
  if (Platform.OS === "web") {
    return AsyncStorage.getItem(TOKEN_KEY);
  }
  return SecureStore.getItemAsync(TOKEN_KEY, SECURE_OPTS);
}

/**
 * One-time migration: tokens saved by earlier builds used the default keychain
 * class (WHEN_UNLOCKED, migratable to a new device via an encrypted backup).
 * Delete and re-add so the item gets SECURE_OPTS — an update alone may keep the
 * old accessibility attribute.
 */
async function migrateTokenAccessibility(token: string) {
  if (Platform.OS === "web") return;
  if (await AsyncStorage.getItem(TOKEN_ACL_MIGRATED_KEY)) return;
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.setItemAsync(TOKEN_KEY, token, SECURE_OPTS);
    await AsyncStorage.setItem(TOKEN_ACL_MIGRATED_KEY, "1");
  } catch {
    // Never lose the session over this: put it back the old way, retry next launch.
    await SecureStore.setItemAsync(TOKEN_KEY, token).catch(() => {});
  }
}

async function removeToken() {
  if (Platform.OS === "web") {
    await AsyncStorage.removeItem(TOKEN_KEY);
  } else {
    await SecureStore.deleteItemAsync(TOKEN_KEY, SECURE_OPTS);
  }
}

/**
 * Tell the server this session is ending. Best-effort and fire-and-forget:
 * /auth/logout is currently a no-op (JWTs are stateless — Panic Wipe uses
 * /auth/logout-all to actually revoke), but it keeps the server in the loop.
 */
function notifyServerLogout(token: string) {
  try {
    void fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  } catch { /* best-effort */ }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Device-local cache of the wizard-completion flag. The account's
  // `onboardingCompleted` (below) is the source of truth; this is only a fast
  // offline fallback and preserves completion for users who finished the wizard
  // before it was tracked server-side.
  const [localWizardDone, setLocalWizardDone] = useState(false);
  const [lastLoginAt, setLastLoginAt] = useState(0);
  const queryClient = useQueryClient();
  const tokenRef = useRef<string | null>(null);
  const lastLoginAtRef = useRef(0);
  const logoutListeners = useRef(new Set<() => void>());

  // Crash reports carry only the numeric account id (see lib/errorReporting).
  useEffect(() => { setReportingUser(user?.id); }, [user?.id]);

  useEffect(() => {
    async function restore() {
      try {
        const [storedToken, storedUser, wizardDone] = await Promise.all([
          getToken(),
          AsyncStorage.getItem(USER_KEY),
          AsyncStorage.getItem(WIZARD_KEY),
        ]);
        if (storedToken && storedUser) {
          const parsedUser = JSON.parse(storedUser) as AuthUser;
          tokenRef.current = storedToken;
          setToken(storedToken);
          setUser(parsedUser);
          setAuthTokenGetter(() => storedToken);
          void migrateTokenAccessibility(storedToken).catch(() => {});
        }
        setLocalWizardDone(wizardDone === "true");
      } catch {
        // ignore
      } finally {
        setIsLoading(false);
      }
    }
    restore();
  }, []);

  const login = async (newToken: string, newUser: AuthUser) => {
    await storeToken(newToken);
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(newUser));
    const now = Date.now();
    lastLoginAtRef.current = now;
    tokenRef.current = newToken;
    setLastLoginAt(now);
    setToken(newToken);
    setUser(newUser);
    setAuthTokenGetter(() => newToken);
  };

  const logout = useCallback(async () => {
    const oldToken = tokenRef.current;
    // Stop attaching the old token to any further request right away.
    tokenRef.current = null;
    if (oldToken) notifyServerLogout(oldToken);
    setAuthTokenGetter(() => null);
    await removeToken().catch(() => {});
    // The wizard flag is per-device, not per-account: drop it so the next person
    // to sign in here isn't treated as onboarded. Returning users are covered by
    // the account's server-side `onboardingCompleted`.
    await AsyncStorage.multiRemove([USER_KEY, WIZARD_KEY]).catch(() => {});
    setToken(null);
    setUser(null);
    setLocalWizardDone(false);
    // Drop every cached query/mutation so the next account never sees the
    // previous one's profile, uploads, connections or stats.
    void queryClient.cancelQueries();
    queryClient.clear();
    for (const listener of Array.from(logoutListeners.current)) {
      try { listener(); } catch { /* a listener must not block sign-out */ }
    }
  }, [queryClient]);

  const onLogout = useCallback((listener: () => void) => {
    logoutListeners.current.add(listener);
    return () => { logoutListeners.current.delete(listener); };
  }, []);

  // When any API call returns 401 (expired/revoked token), clear the session so
  // the user is routed back to login instead of being stuck with silent failures.
  // Ignored when already signed out, and just after a sign-in (see
  // POST_LOGIN_401_GRACE_MS) so a stale request can't end the new session.
  const reportUnauthorized = useCallback((tokenUsed?: string | null) => {
    if (!tokenRef.current) return;
    // A request made with an older token says nothing about the current session.
    if (tokenUsed && tokenUsed !== tokenRef.current) return;
    if (Date.now() - lastLoginAtRef.current < POST_LOGIN_401_GRACE_MS) return;
    void logout();
  }, [logout]);

  useEffect(() => {
    setUnauthorizedHandler(() => reportUnauthorized());
    return () => setUnauthorizedHandler(null);
  }, [reportUnauthorized]);

  const updateUser = (newUser: AuthUser) => {
    setUser(newUser);
    AsyncStorage.setItem(USER_KEY, JSON.stringify(newUser));
  };

  const completeWizard = async () => {
    // Mark locally first so navigation is instant and survives offline, then
    // persist to the account so onboarding never re-shows on another device.
    await AsyncStorage.setItem(WIZARD_KEY, "true");
    setLocalWizardDone(true);
    try {
      const updated = await updateMe({ onboardingCompleted: true });
      setUser(updated as AuthUser);
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(updated));
    } catch {
      // Offline / transient failure: the local flag suppresses re-show on this
      // device; the next successful login or /me fetch carries the server value.
    }
  };

  const value = useMemo<AuthContextValue>(() => ({
    user, token, isLoading,
    isAuthenticated: !!token && !!user,
    hasCompletedWizard: !!user?.onboardingCompleted || localWizardDone,
    lastLoginAt,
    login, logout, onLogout, reportUnauthorized, updateUser, completeWizard,
  }), [user, token, isLoading, localWizardDone, lastLoginAt, logout, onLogout, reportUnauthorized]); // eslint-disable-line react-hooks/exhaustive-deps

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
