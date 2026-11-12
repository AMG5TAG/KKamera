// Panic Wipe, device side: remove everything KKamera keeps on this device.
//
// Covers: the durable upload queue (every account's queued copies + its
// directory), the app cache directory (raw captures, originals kept when
// "delete local file after upload" is off, markup/scan/panorama temp files),
// every `kkamera*` AsyncStorage key (settings, cached upload target and
// subscription snapshot, OAuth nonces, persisted queue, user/wizard flags),
// the SecureStore entries (session token, app-lock PIN and attempt counter),
// the in-memory uploads list, the React Query cache, and the RevenueCat
// identity. Copies already saved to the Photos library are NOT touched — the
// app only has add-only access to it.
//
// Each step is best-effort and isolated: one failure never stops the rest.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import type { QueryClient } from "@tanstack/react-query";
import { clearPin } from "@/lib/appLock";
import { logOutRevenueCat } from "@/lib/revenuecat";
import { wipeUploadQueueDirectory } from "@/contexts/UploadContext";

/** SecureStore can't enumerate its keys, so every key the app writes is listed here. */
const SECURE_STORE_KEYS = ["kkamera_token", "kkamera_app_pin_v2", "kkamera_app_lock_attempts"];

/** AsyncStorage keys owned by KKamera (`kkamera_…`, `kkamera.…`, `@kkamera/…`). */
function isAppKey(key: string): boolean {
  return /^@?kkamera/i.test(key);
}

async function step(fn: () => unknown | Promise<unknown>) {
  try { await fn(); } catch { /* best-effort: keep wiping */ }
}

/** Delete every entry inside the app cache directory (not the directory itself). */
function clearCacheDirectory() {
  if (Platform.OS === "web") return;
  const cache = Paths.cache;
  if (!cache.exists) return;
  for (const entry of cache.list()) {
    try {
      if (entry instanceof Directory || entry instanceof File) entry.delete();
    } catch { /* in use / OS-managed — skip */ }
  }
}

export interface LocalWipeDeps {
  /** UploadContext.discardQueue — stops retries and drops every queued item + the uploads list. */
  discardQueue: (scope?: "all" | "mine") => Promise<void>;
  /** SettingsContext.resetSettings — resets in-memory settings and removes the stored copy. */
  resetSettings: () => Promise<void>;
  queryClient: QueryClient;
}

/**
 * Wipe all local KKamera data. Does NOT sign out or touch the server — the
 * caller revokes sessions server-side first and calls `logout()` afterwards
 * (logout also runs its listeners and routes to the login screen).
 */
export async function wipeAllLocalData(deps: LocalWipeDeps): Promise<void> {
  // Queue first, so nothing starts uploading (or re-persists) mid-wipe.
  await step(() => deps.discardQueue("all"));
  await step(wipeUploadQueueDirectory);
  await step(clearCacheDirectory);

  await step(deps.resetSettings);
  await step(clearPin);

  await step(async () => {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter(isAppKey);
    if (mine.length) await AsyncStorage.multiRemove(mine);
  });
  if (Platform.OS === "web") {
    await step(() => {
      const ss = typeof window !== "undefined" ? window.sessionStorage : null;
      if (!ss) return;
      for (let i = ss.length - 1; i >= 0; i--) {
        const k = ss.key(i);
        if (k && isAppKey(k)) ss.removeItem(k);
      }
    });
  } else {
    for (const key of SECURE_STORE_KEYS) {
      await step(() => SecureStore.deleteItemAsync(key));
      await step(() => SecureStore.deleteItemAsync(key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }));
    }
  }

  await step(async () => {
    await deps.queryClient.cancelQueries();
    deps.queryClient.clear();
  });
  await step(logOutRevenueCat);
}
