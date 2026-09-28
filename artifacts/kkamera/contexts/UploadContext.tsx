import React, {
  createContext, useContext, useState, useCallback, useMemo,
  useRef, useEffect, type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import { File, Directory, Paths } from "expo-file-system";
import * as Network from "expo-network";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "./AuthContext";
import { useSettings } from "./SettingsContext";
import { API_BASE_URL } from "@/lib/config";

export type UploadStatus = "idle" | "queued" | "uploading" | "done" | "failed" | "partial";

export interface UploadEntry {
  id: string;
  fileName: string;
  fileType: string;
  status: UploadStatus;
  progress: number; // 0–100
  error?: string;
  timestamp: number;
}

/** A capture still held on this device by the durable upload queue. */
export interface QueuedUpload {
  id: string;
  fileName: string;
  fileType: "image" | "video";
  /** uploading = in flight; queued = waiting/parked, will retry by itself; partial = some destinations still missing; failed = needs the user (Retry / Discard). */
  status: "uploading" | "queued" | "partial" | "failed";
  /** Human-readable reason / next step, e.g. "Waiting for Wi-Fi". */
  error?: string;
  /** Upload attempts made so far. */
  attempts: number;
  /** When the next automatic attempt is due (null = waiting on an event, or not automatic). */
  nextRetryAt: number | null;
  createdAt: number;
}

interface UploadContextValue {
  uploads: UploadEntry[];
  lastUpload: UploadEntry | null;
  addUpload: (fileName: string, fileType: string) => string;
  updateUpload: (id: string, updates: Partial<UploadEntry>) => void;
  clearCompleted: () => void;
  /**
   * Persist a capture to the durable queue and start uploading it in the
   * background. Resolves once the capture is safely queued — NOT when the
   * network upload finishes — so callers may fire-and-forget. Wi-Fi-only,
   * retries, auth and subscription parking are all handled by the queue.
   */
  executeUpload: (
    uri: string,
    fileName: string,
    fileType: "image" | "video",
    token: string | null,
    connectionIds?: number[],
    onDeleteLocal?: () => Promise<void>
  ) => Promise<void>;
  /** Wake every parked/waiting capture for the signed-in account and try now. */
  retryQueued: (token?: string | null) => void;
  /** Captures for the signed-in account still held on this device. */
  queuedItems: QueuedUpload[];
  /** Retry one queued/failed capture now (resets its backoff). */
  retryItem: (id: string) => void;
  /** Drop one queued capture and delete its local copy. */
  discardItem: (id: string) => Promise<void>;
  /** Drop every queued capture and delete its local copy (panic wipe, account deletion). */
  discardQueue: () => Promise<void>;
}

const UploadContext = createContext<UploadContextValue | null>(null);

type ParkReason = "auth" | "subscription" | "no-cloud";

interface QueuedItem {
  id: string;
  /** File the upload reads from — the durable queue copy when one could be made. */
  uri: string;
  /** The capture as handed to executeUpload (deleted after success unless the caller keeps it). */
  originalUri?: string;
  fileName: string;
  fileType: "image" | "video";
  /** Destinations still to receive the file (undefined = all active connections). */
  connectionIds?: number[];
  /** Network/server-error attempts, drives the backoff. */
  retries: number;
  nextRetryAt: number;
  /** Account that captured the item — it only ever uploads under that account. */
  ownerId: number | null;
  /** waiting = retried automatically; parked = waits for an event; failed = waits for the user. */
  state?: "waiting" | "parked" | "failed";
  parkReason?: ParkReason;
  error?: string;
  /** Last server result was partial: some destinations have the file, some don't. */
  partial?: boolean;
  /** Attempts that reached the server but left destinations failing. */
  destAttempts?: number;
  createdAt?: number;
  /** Caller supplied its own onDeleteLocal — survives persistence so a rehydrated item doesn't default-delete the original. */
  customDelete?: boolean;
  onDeleteLocal?: () => Promise<void>;
}

const offlineQueue: QueuedItem[] = [];
/** Ids currently being uploaded. In memory only — a persisted item is never "in flight" after a restart. */
const inFlight = new Set<string>();

const MAX_CONCURRENT = 2;
/** Server reached but destinations kept failing — stop auto-retrying after this and hand it to the user. */
const MAX_DEST_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 5 * 60_000;

// Persist the offline queue so captures survive an app kill/restart. The
// onDeleteLocal callback can't be serialised, so it's dropped on persist and
// replaced by the `customDelete` flag.
const OFFLINE_QUEUE_KEY = "@kkamera/offline-upload-queue";

// Set once the persisted queue has been read back. Until then persistQueue is a
// no-op: writing earlier would overwrite the stored queue with whatever happens
// to be in memory (on a cold start, nothing) before it could be restored.
let queueHydrated = false;

async function persistQueue() {
  if (!queueHydrated) return;
  try {
    const serialisable = offlineQueue.map(({ onDeleteLocal, ...rest }) => rest);
    await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(serialisable));
  } catch { /* best-effort persistence */ }
}

function backoffMs(retries: number): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, retries));
  return Math.round(base * (0.85 + Math.random() * 0.3)); // light jitter
}

function formatDelay(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)} min`;
}

const PARK_MESSAGES: Record<ParkReason, string> = {
  auth: "Signed out — will upload when you sign back in",
  subscription: "Subscription required — will upload when your subscription is active",
  "no-cloud": "No cloud connected — will upload when you connect one",
};

/** Best-effort MIME type from the file extension, falling back by media kind. */
function guessMimeType(fileName: string, fileType: "image" | "video"): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", webp: "image/webp",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", m4v: "video/x-m4v",
  };
  return map[ext] ?? (fileType === "video" ? "video/mp4" : "image/jpeg");
}

const BASE_URL = API_BASE_URL;

/** Non-2xx response from the upload endpoint. */
class UploadHttpError extends Error {
  constructor(public httpStatus: number, message: string) {
    super(message);
  }
}

interface ExecuteResult {
  status: string;
  results?: { connectionId?: number; success?: boolean; error?: string }[];
}

function xhrUpload(
  uri: string,
  fileName: string,
  fileType: "image" | "video",
  token: string,
  connectionIds: number[] | undefined,
  clientUploadId: string,
  onProgress: (pct: number) => void
): Promise<ExecuteResult> {
  return new Promise((resolve, reject) => {
    try {
      // Derive the MIME type from the actual file extension so the bytes aren't
      // mislabelled (e.g. a web-recorded .webm previously sent as video/mp4).
      const mimeType = guessMimeType(fileName, fileType);
      const form = new FormData();

      // React Native's FormData takes a { uri, name, type } file descriptor and
      // streams the file itself. Fetching a file:// URI into a Blob is unreliable
      // on Android and for large videos.
      form.append("file", { uri, name: fileName, type: mimeType } as any);
      form.append("fileName", fileName);
      form.append("mimeType", mimeType);
      // Stable per-capture id so the server can de-duplicate retried uploads.
      form.append("clientUploadId", clientUploadId);
      if (connectionIds?.length) {
        form.append("connectionIds", JSON.stringify(connectionIds));
      }

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${BASE_URL}/api/uploads/execute`);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { reject(new UploadHttpError(502, "Invalid server response")); }
        } else {
          let message = `Upload failed: ${xhr.status} ${xhr.statusText}`.trim();
          try {
            const body = JSON.parse(xhr.responseText);
            if (body?.message) message = String(body.message);
          } catch { /* keep the generic message */ }
          reject(new UploadHttpError(xhr.status, message));
        }
      };

      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.ontimeout = () => reject(new Error("Upload timed out"));
      xhr.timeout = 5 * 60 * 1000; // 5 min

      xhr.send(form);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Best-effort delete of a local capture. Uses the SDK 54 File API — the legacy
 * `deleteAsync` export from "expo-file-system" is a stub that always throws.
 */
export async function deleteLocalFile(uri: string) {
  if (Platform.OS === "web") return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch { /* best-effort */ }
}

// Captures are written to the OS cache directory, which the system can purge
// while an upload waits in the offline queue (especially across an app kill).
// Copy every capture into the durable document directory before the first
// attempt so a retry (possibly after an app kill) still has its bytes.
const QUEUE_DIR = Platform.OS === "web" ? null : new Directory(Paths.document, "upload-queue");

function persistForQueue(uri: string, id: string): string {
  if (!QUEUE_DIR) return uri;
  try {
    if (!QUEUE_DIR.exists) QUEUE_DIR.create({ intermediates: true });
    const base = uri.split("?")[0] ?? uri;
    const ext = base.includes(".") ? base.split(".").pop() : undefined;
    const dest = new File(QUEUE_DIR, ext ? `${id}.${ext}` : id);
    if (dest.exists) dest.delete();
    new File(uri).copy(dest);
    return dest.uri;
  } catch {
    return uri; // couldn't copy — fall back to the original URI (no regression)
  }
}

function isQueueUri(uri: string): boolean {
  return QUEUE_DIR != null && uri.startsWith(QUEUE_DIR.uri);
}

function localFileExists(uri: string): boolean {
  if (Platform.OS === "web") return true;
  try { return new File(uri).exists; } catch { return true; /* can't tell — let the upload try */ }
}

/** Delete the queue copy, and the original too unless the caller asked to keep it. */
async function deleteItemFiles(item: QueuedItem) {
  if (isQueueUri(item.uri)) await deleteLocalFile(item.uri);
  const original = item.originalUri ?? (isQueueUri(item.uri) ? undefined : item.uri);
  if (original && !item.customDelete && !isQueueUri(original)) await deleteLocalFile(original);
}

function isRetryableHttp(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function newId(): string {
  return Date.now().toString() + Math.random().toString(36).slice(2, 9);
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const tokenRef = useRef<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [queueReady, setQueueReady] = useState(queueHydrated);
  const [queueVersion, setQueueVersion] = useState(0);
  const { token, user, isLoading: authLoading, logout } = useAuth();
  const { settings, isLoading: settingsLoading } = useSettings();
  const userId = user?.id ?? null;
  const userIdRef = useRef<number | null>(userId);
  userIdRef.current = userId;
  const wifiOnlyRef = useRef(settings.uploadOnlyOnWifi);
  wifiOnlyRef.current = settings.uploadOnlyOnWifi;
  const settingsReadyRef = useRef(!settingsLoading);
  settingsReadyRef.current = !settingsLoading;
  const logoutRef = useRef(logout);
  logoutRef.current = logout;
  const processRef = useRef<() => void>(() => {});

  // Keep the latest token available to background retries.
  useEffect(() => { if (token) tokenRef.current = token; }, [token]);

  /** Re-render consumers of queuedItems after mutating the module-level queue. */
  const syncQueue = useCallback(() => setQueueVersion(v => v + 1), []);

  const addUpload = useCallback((fileName: string, fileType: string): string => {
    const id = newId();
    const entry: UploadEntry = {
      id, fileName, fileType, status: "uploading", progress: 0, timestamp: Date.now(),
    };
    setUploads(prev => [entry, ...prev].slice(0, 50));
    return id;
  }, []);

  const updateUpload = useCallback((id: string, updates: Partial<UploadEntry>) => {
    setUploads(prev => prev.map(u => u.id === id ? { ...u, ...updates } : u));
  }, []);

  const clearCompleted = useCallback(() => {
    setUploads(prev => prev.filter(u => u.status !== "done"));
  }, []);

  /** Mirror a queue item's state into the uploads list (camera badge), adding an entry if missing. */
  const reflect = useCallback((item: QueuedItem, updates: Partial<UploadEntry>) => {
    setUploads(prev => {
      if (prev.some(u => u.id === item.id)) {
        return prev.map(u => u.id === item.id ? { ...u, ...updates } : u);
      }
      const entry: UploadEntry = {
        id: item.id, fileName: item.fileName, fileType: item.fileType,
        status: "queued", progress: 0, timestamp: item.createdAt ?? Date.now(), ...updates,
      };
      return [entry, ...prev].slice(0, 50);
    });
  }, []);

  const clearTimer = () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  };

  /** Upload one item. Never removes it from storage unless the server confirmed success. */
  const attempt = useCallback(async (item: QueuedItem, authToken: string) => {
    inFlight.add(item.id);
    syncQueue();
    reflect(item, { status: "uploading", progress: 0, error: undefined });

    const stillQueued = () => offlineQueue.includes(item);
    const finish = () => {
      inFlight.delete(item.id);
      persistQueue();
      syncQueue();
      processRef.current();
    };

    if (!localFileExists(item.uri)) {
      item.state = "failed";
      item.error = "The file is no longer on this device";
      reflect(item, { status: "failed", error: item.error });
      finish();
      return;
    }

    let result: ExecuteResult;
    try {
      result = await xhrUpload(
        item.uri, item.fileName, item.fileType, authToken, item.connectionIds, item.id,
        (pct) => updateUpload(item.id, { progress: pct }),
      );
    } catch (err: any) {
      if (!stillQueued()) { finish(); return; } // discarded while in flight
      const httpStatus: number | undefined = err instanceof UploadHttpError ? err.httpStatus : undefined;

      if (httpStatus === 401) {
        // Token expired/revoked. Park until the same account signs back in, and
        // sign out like any other 401 from the API client would.
        item.state = "parked";
        item.parkReason = "auth";
        item.error = PARK_MESSAGES.auth;
        reflect(item, { status: "queued", error: item.error });
        finish();
        void logoutRef.current().catch(() => {});
        return;
      }
      if (httpStatus === 402) {
        item.state = "parked";
        item.parkReason = "subscription";
        item.error = PARK_MESSAGES.subscription;
        reflect(item, { status: "queued", error: item.error });
        finish();
        return;
      }
      if (httpStatus != null && !isRetryableHttp(httpStatus)) {
        // 400/413/… — retrying won't help, but keep the local copy so the user
        // can retry or discard it from History.
        item.state = "failed";
        item.error = err.message || `Upload failed (${httpStatus})`;
        reflect(item, { status: "failed", error: item.error });
        finish();
        return;
      }

      // Network error, timeout, 5xx/408/429: retry indefinitely with backoff.
      const delay = backoffMs(item.retries);
      item.retries += 1;
      item.state = "waiting";
      item.nextRetryAt = Date.now() + delay;
      item.error = `Retrying in ${formatDelay(delay)} (attempt ${item.retries + 1})`;
      reflect(item, { status: "queued", error: item.error });
      finish();
      return;
    }

    if (!stillQueued()) { finish(); return; }
    const status = result.status || "done";
    const results = Array.isArray(result.results) ? result.results : [];

    if (status === "done") {
      offlineQueue.splice(offlineQueue.indexOf(item), 1);
      await persistQueue();
      reflect(item, { status: "done", progress: 100, error: undefined });
      // Delete the original capture after confirmed upload (unless the caller
      // keeps it), then the durable queue copy.
      if (item.onDeleteLocal) {
        await item.onDeleteLocal().catch(() => {});
      } else if (!item.customDelete) {
        const original = item.originalUri ?? item.uri;
        if (!isQueueUri(original)) await deleteLocalFile(original);
      }
      if (isQueueUri(item.uri)) await deleteLocalFile(item.uri);
      finish();
      return;
    }

    if (status === "queued") {
      // The server accepted the request but had no active destination for it.
      item.state = "parked";
      item.parkReason = "no-cloud";
      item.error = PARK_MESSAGES["no-cloud"];
      reflect(item, { status: "queued", progress: 0, error: item.error });
      finish();
      return;
    }

    // "partial" or "failed": some/all destinations rejected the file. Retry only
    // the destinations that failed, when the server tells us which ones.
    const failed = results.filter(r => !r?.success);
    const failedIds = failed
      .map(r => r?.connectionId)
      .filter((n): n is number => typeof n === "number");
    const errors = failed.map(r => r?.error).filter(Boolean).join("; ");
    item.partial = item.partial || status === "partial";
    item.destAttempts = (item.destAttempts ?? 0) + 1;
    const uiStatus: UploadStatus = item.partial ? "partial" : "failed";

    if (failedIds.length === 0 || failedIds.length !== failed.length || item.destAttempts >= MAX_DEST_ATTEMPTS) {
      // Can't target the failed destinations precisely, or they keep failing:
      // stop auto-retrying but keep the local copy for the user.
      item.state = "failed";
      item.error = errors || (item.partial ? "Some destinations failed" : "Upload failed");
      reflect(item, { status: uiStatus, progress: 100, error: item.error });
      finish();
      return;
    }

    item.connectionIds = failedIds;
    const delay = backoffMs(item.destAttempts);
    item.state = "waiting";
    item.nextRetryAt = Date.now() + delay;
    item.error = `${errors || "Some destinations failed"} — retrying in ${formatDelay(delay)}`;
    reflect(item, { status: uiStatus, progress: 100, error: item.error });
    finish();
  }, [reflect, syncQueue, updateUpload]);

  /** Dispatch every due item for the signed-in account and re-arm the timer. */
  const processQueue = useCallback(async () => {
    clearTimer();
    if (!queueHydrated || !settingsReadyRef.current) return;
    const owner = userIdRef.current;
    const authToken = tokenRef.current;
    if (owner == null || !authToken) return; // paused until sign-in

    const mine = () => offlineQueue.filter(i => i.ownerId === owner && !inFlight.has(i.id));
    const due = () => mine().filter(i => (i.state ?? "waiting") === "waiting" && i.nextRetryAt <= Date.now());
    if (due().length === 0) {
      armTimer();
      return;
    }

    if (Platform.OS !== "web") {
      let net: Network.NetworkState | null = null;
      try { net = await Network.getNetworkStateAsync(); } catch { /* unknown — try anyway */ }
      if (net?.isConnected === false) {
        for (const item of due()) {
          item.error = "Waiting for a connection";
          reflect(item, { status: "queued", error: item.error });
        }
        syncQueue();
        // The connectivity listener normally wakes us; poll slowly as a fallback.
        retryTimerRef.current = setTimeout(() => processRef.current(), 60_000);
        return;
      }
      if (wifiOnlyRef.current && net && net.type !== Network.NetworkStateType.WIFI) {
        for (const item of due()) {
          item.error = "Waiting for Wi-Fi";
          reflect(item, { status: "queued", error: item.error });
        }
        syncQueue();
        return; // the connectivity listener / foreground wakes us
      }
    }

    // Re-check auth after the await — the account may have changed meanwhile.
    if (userIdRef.current !== owner || !tokenRef.current) return;
    const slots = Math.max(0, MAX_CONCURRENT - inFlight.size);
    for (const item of due().slice(0, slots)) void attempt(item, tokenRef.current);
    armTimer();

    function armTimer() {
      clearTimer();
      const waiting = mine().filter(i => (i.state ?? "waiting") === "waiting");
      if (waiting.length === 0) return;
      const soonest = Math.min(...waiting.map(i => i.nextRetryAt));
      const delay = Math.max(1000, soonest - Date.now());
      retryTimerRef.current = setTimeout(() => processRef.current(), delay);
    }
  }, [attempt, reflect, syncQueue]);

  processRef.current = () => { void processQueue(); };

  /** Make parked items (and not-yet-due waiting ones) eligible right now. */
  const wake = useCallback((includeAuth: boolean) => {
    const owner = userIdRef.current;
    const now = Date.now();
    for (const item of offlineQueue) {
      if (item.ownerId !== owner || inFlight.has(item.id)) continue;
      if (item.state === "parked" && (includeAuth || item.parkReason !== "auth")) {
        item.state = "waiting";
        item.parkReason = undefined;
      }
      if ((item.state ?? "waiting") === "waiting") item.nextRetryAt = now;
    }
    persistQueue();
    syncQueue();
    processRef.current();
  }, [syncQueue]);

  const executeUpload = useCallback(async (
    uri: string,
    fileName: string,
    fileType: "image" | "video",
    token: string | null,
    connectionIds?: number[],
    onDeleteLocal?: () => Promise<void>
  ) => {
    const id = addUpload(fileName, fileType);
    if (token) tokenRef.current = token;
    const queueUri = persistForQueue(uri, id);
    const item: QueuedItem = {
      id, uri: queueUri, originalUri: uri, fileName, fileType, connectionIds,
      retries: 0, nextRetryAt: Date.now(), ownerId: userIdRef.current,
      state: "waiting", createdAt: Date.now(),
      customDelete: onDeleteLocal != null, onDeleteLocal,
    };
    offlineQueue.push(item);
    // Durable before the first network attempt (no-op until hydration, which
    // writes back everything in memory, this item included).
    await persistQueue();
    syncQueue();
    if (!tokenRef.current) {
      updateUpload(id, { status: "queued", error: "Queued — will upload when you sign in" });
      return;
    }
    updateUpload(id, { status: "queued", progress: 0 });
    processRef.current();
  }, [addUpload, updateUpload, syncQueue]);

  const retryQueued = useCallback((token?: string | null) => {
    if (token) tokenRef.current = token;
    wake(false);
  }, [wake]);

  const retryItem = useCallback((id: string) => {
    const item = offlineQueue.find(i => i.id === id);
    if (!item || item.ownerId !== userIdRef.current || inFlight.has(id)) return;
    item.state = "waiting";
    item.parkReason = undefined;
    item.retries = 0;
    item.destAttempts = 0;
    item.nextRetryAt = Date.now();
    item.error = undefined;
    reflect(item, { status: "queued", error: undefined });
    persistQueue();
    syncQueue();
    processRef.current();
  }, [reflect, syncQueue]);

  const discardItem = useCallback(async (id: string) => {
    const idx = offlineQueue.findIndex(i => i.id === id);
    if (idx < 0) return;
    const [item] = offlineQueue.splice(idx, 1);
    await persistQueue();
    setUploads(prev => prev.filter(u => u.id !== id));
    syncQueue();
    if (item) await deleteItemFiles(item);
  }, [syncQueue]);

  const discardQueue = useCallback(async () => {
    clearTimer();
    const items = offlineQueue.splice(0, offlineQueue.length);
    await persistQueue();
    await Promise.all(items.map(deleteItemFiles));
    setUploads([]);
    syncQueue();
  }, [syncQueue]);

  // Rehydrate the persisted offline queue once per app launch so captures
  // survive an app kill. Nothing is persisted until this has finished.
  useEffect(() => {
    if (queueHydrated) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
        const saved = raw ? JSON.parse(raw) : [];
        if (Array.isArray(saved)) {
          const existing = new Set(offlineQueue.map(i => i.id));
          for (const item of saved as QueuedItem[]) {
            // Items without an owner predate per-account tagging and can't be
            // safely attributed, so they are discarded.
            if (item?.uri && item?.id && typeof item.ownerId === "number" && !existing.has(item.id)) {
              offlineQueue.push({
                ...item,
                retries: typeof item.retries === "number" ? item.retries : 0,
                state: item.state ?? "waiting",
                // Anything that was in flight when the app died is simply due again.
                nextRetryAt: item.state === "waiting" || !item.state ? Date.now() : item.nextRetryAt,
                createdAt: item.createdAt ?? Date.now(),
              });
            }
          }
        }
      } catch { /* ignore malformed persisted queue */ }
      queueHydrated = true;
      // Write back once, so anything queued while we were reading is saved too.
      persistQueue();
      if (!cancelled) {
        setQueueReady(true);
        syncQueue();
      }
    })();
    return () => { cancelled = true; };
  }, [syncQueue]);

  // React to the signed-in account once both the queue and the auth session
  // have been restored. Signing out only pauses retries: queued captures stay
  // on disk tagged with their owner, so the same account picks them up again
  // after signing back in (e.g. after a 401). Signing in as a different account
  // discards the previous account's captures so they can never upload under
  // the new account's token.
  useEffect(() => {
    if (!queueReady || authLoading) return;

    if (userId == null || !token) {
      tokenRef.current = null;
      clearTimer();
      return;
    }

    let removed = false;
    for (let i = offlineQueue.length - 1; i >= 0; i--) {
      const item = offlineQueue[i]!;
      if (item.ownerId !== userId) {
        offlineQueue.splice(i, 1);
        if (isQueueUri(item.uri)) void deleteLocalFile(item.uri);
        removed = true;
      }
    }
    if (removed) persistQueue();

    // Surface restored captures in the status UI so a queued upload isn't
    // silently retrying with no visible entry or badge.
    for (const item of offlineQueue) {
      if (inFlight.has(item.id)) continue;
      reflect(item, {
        status: item.state === "failed" ? (item.partial ? "partial" : "failed") : "queued",
        error: item.error ?? "Queued — will upload when online",
      });
    }
    // Signed in (again): resume everything, including auth-parked captures.
    wake(true);
  }, [queueReady, authLoading, userId, token, reflect, wake]);

  // Settings finished loading or Wi-Fi-only was switched: re-evaluate.
  useEffect(() => {
    if (!settingsLoading) processRef.current();
  }, [settingsLoading, settings.uploadOnlyOnWifi]);

  // Retry immediately when the app returns to the foreground…
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") wake(false);
    });
    return () => sub.remove();
  }, [wake]);

  // …and when connectivity comes back (or switches to Wi-Fi).
  useEffect(() => {
    if (Platform.OS === "web") return;
    let sub: { remove: () => void } | null = null;
    try {
      sub = Network.addNetworkStateListener((state) => {
        if (state.isConnected !== false) wake(false);
      });
    } catch { /* listener unavailable — foreground/timer retries still apply */ }
    return () => sub?.remove();
  }, [wake]);

  useEffect(() => () => clearTimer(), []);

  const queuedItems = useMemo<QueuedUpload[]>(() => {
    if (userId == null) return [];
    return offlineQueue
      .filter(i => i.ownerId === userId)
      .map(i => {
        const uploading = inFlight.has(i.id);
        const state = i.state ?? "waiting";
        const status: QueuedUpload["status"] = uploading
          ? "uploading"
          : state === "failed" ? (i.partial ? "partial" : "failed") : "queued";
        return {
          id: i.id,
          fileName: i.fileName,
          fileType: i.fileType,
          status,
          error: uploading ? undefined : i.error ?? (token ? "Queued" : "Queued — will upload when you sign in"),
          attempts: i.retries + (i.destAttempts ?? 0),
          nextRetryAt: !uploading && state === "waiting" ? i.nextRetryAt : null,
          createdAt: i.createdAt ?? Date.now(),
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    // queueVersion bumps whenever the module-level queue mutates.
  }, [queueVersion, userId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastUpload = uploads[0] ?? null;

  const value = useMemo<UploadContextValue>(() => ({
    uploads, lastUpload, addUpload, updateUpload, clearCompleted, executeUpload,
    retryQueued, queuedItems, retryItem, discardItem, discardQueue,
  }), [uploads, lastUpload, addUpload, updateUpload, clearCompleted, executeUpload,
    retryQueued, queuedItems, retryItem, discardItem, discardQueue]);

  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}

export function useUpload() {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUpload must be used within UploadProvider");
  return ctx;
}
