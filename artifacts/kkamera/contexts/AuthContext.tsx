import React, { createContext, useContext, useState, useEffect, useMemo, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { setAuthTokenGetter, setBaseUrl, setUnauthorizedHandler } from "@workspace/api-client-react";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  referralCode: string;
  twoFAEnabled: boolean;
  createdAt: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  hasCompletedWizard: boolean;
  login: (token: string, user: AuthUser) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (user: AuthUser) => void;
  completeWizard: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_KEY = "kkamera_token";
const USER_KEY = "kkamera_user";
const WIZARD_KEY = "kkamera_wizard_done";

async function storeToken(token: string) {
  if (Platform.OS === "web") {
    await AsyncStorage.setItem(TOKEN_KEY, token);
  } else {
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  }
}

async function getToken(): Promise<string | null> {
  if (Platform.OS === "web") {
    return AsyncStorage.getItem(TOKEN_KEY);
  }
  return SecureStore.getItemAsync(TOKEN_KEY);
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
  const [hasCompletedWizard, setHasCompletedWizard] = useState(false);

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
          setToken(storedToken);
          setUser(parsedUser);
          setAuthTokenGetter(() => storedToken);
        }
        setHasCompletedWizard(wizardDone === "true");
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
    setToken(newToken);
    setUser(newUser);
    setAuthTokenGetter(() => newToken);
  };

  const logout = async () => {
    await removeToken();
    await AsyncStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
    setAuthTokenGetter(() => null);
  };

  // When any API call returns 401 (expired/revoked token), clear the session so
  // the user is routed back to login instead of being stuck with silent failures.
  useEffect(() => {
    setUnauthorizedHandler(() => { void logout(); });
    return () => setUnauthorizedHandler(null);
  }, []);

  const updateUser = (newUser: AuthUser) => {
    setUser(newUser);
    AsyncStorage.setItem(USER_KEY, JSON.stringify(newUser));
  };

  const completeWizard = async () => {
    await AsyncStorage.setItem(WIZARD_KEY, "true");
    setHasCompletedWizard(true);
  };

  const value = useMemo<AuthContextValue>(() => ({
    user, token, isLoading,
    isAuthenticated: !!token && !!user,
    hasCompletedWizard,
    login, logout, updateUser, completeWizard,
  }), [user, token, isLoading, hasCompletedWizard]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
