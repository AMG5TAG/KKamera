import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { setAuthTokenGetter, setUnauthorizedHandler, updateMe } from "@workspace/api-client-react";

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
  updateUser: (user: AuthUser) => void;
  completeWizard: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_KEY = "kkamera_token";
const USER_KEY = "kkamera_user";
const WIZARD_KEY = "kkamera_wizard_done";

/**
 * A 401 arriving this soon after an interactive sign-in almost certainly belongs
 * to a request made with the PREVIOUS session's token (the unauthorized handler
 * isn't told which token a request used), so it must not sign the new session out.
 */
const POST_LOGIN_401_GRACE_MS = 5_000;

// Keep the session token off encrypted backups and other devices (THIS_DEVICE_ONLY),
// and unreadable until the first unlock after boot. AFTER_FIRST_UNLOCK (not
// WHEN_UNLOCKED) so a backgrounded upload can still read it on a locked device.
// Matches the PIN's protection class in lib/appLock.ts.
const TOKEN_SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

async function storeToken(token: string) {
  if (Platform.OS === "web") {
    await AsyncStorage.setItem(TOKEN_KEY, token);
  } else {
    await SecureStore.setItemAsync(TOKEN_KEY, token, TOKEN_SECURE_OPTS);
  }
}

async function getToken(): Promise<string | null> {
  if (Platform.OS === "web") {
    return AsyncStorage.getItem(TOKEN_KEY);
  }
  return SecureStore.getItemAsync(TOKEN_KEY, TOKEN_SECURE_OPTS);
}

async function removeToken() {
  if (Platform.OS === "web") {
    await AsyncStorage.removeItem(TOKEN_KEY);
  } else {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  }
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
    // Stop attaching the old token to any further request right away.
    tokenRef.current = null;
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
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!tokenRef.current) return;
      if (Date.now() - lastLoginAtRef.current < POST_LOGIN_401_GRACE_MS) return;
      void logout();
    });
    return () => setUnauthorizedHandler(null);
  }, [logout]);

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
    login, logout, onLogout, updateUser, completeWizard,
  }), [user, token, isLoading, localWizardDone, lastLoginAt, logout, onLogout]); // eslint-disable-line react-hooks/exhaustive-deps

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
