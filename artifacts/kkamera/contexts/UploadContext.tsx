import React, {
  createContext, useContext, useState, useCallback, useMemo,
  useRef, useEffect, type ReactNode,
} from "react";
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system";

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

interface UploadContextValue {
  uploads: UploadEntry[];
  lastUpload: UploadEntry | null;
  addUpload: (fileName: string, fileType: string) => string;
  updateUpload: (id: string, updates: Partial<UploadEntry>) => void;
  clearCompleted: () => void;
  executeUpload: (
    uri: string,
    fileName: string,
    fileType: "image" | "video",
    token: string | null,
    connectionIds?: number[],
    onDeleteLocal?: () => Promise<void>
  ) => Promise<void>;
  retryQueued: (token: string | null) => void;
}

const UploadContext = createContext<UploadContextValue | null>(null);

interface QueuedItem {
  id: string;
  uri: string;
  fileName: string;
  fileType: "image" | "video";
  connectionIds?: number[];
  retries: number;
  nextRetryAt: number;
  onDeleteLocal?: () => Promise<void>;
}

const offlineQueue: QueuedItem[] = [];
const MAX_RETRIES = 5;

function backoffMs(retries: number): number {
  return Math.min(30_000, 1_000 * Math.pow(2, retries));
}

const BASE_URL = process.env["EXPO_PUBLIC_DOMAIN"]
  ? `https://${process.env["EXPO_PUBLIC_DOMAIN"]}`
  : "";

function xhrUpload(
  uri: string,
  fileName: string,
  fileType: "image" | "video",
  token: string,
  connectionIds: number[] | undefined,
  onProgress: (pct: number) => void
): Promise<{ status: string; results: any[] }> {
  return new Promise(async (resolve, reject) => {
    try {
      let blob: Blob;
      if (Platform.OS === "web") {
        const r = await fetch(uri);
        blob = await r.blob();
      } else {
        const r = await fetch(uri);
        blob = await r.blob();
      }

      const mimeType = fileType === "video" ? "video/mp4" : "image/jpeg";
      const form = new FormData();
      form.append("file", blob, fileName);
      form.append("fileName", fileName);
      form.append("mimeType", mimeType);
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
          catch { reject(new Error("Invalid server response")); }
        } else {
          reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`));
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

async function deleteLocalFile(uri: string) {
  if (Platform.OS === "web") return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch { /* best-effort */ }
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const tokenRef = useRef<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const addUpload = useCallback((fileName: string, fileType: string): string => {
    const id = Date.now().toString() + Math.random().toString(36).slice(2, 9);
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

  const scheduleRetry = useCallback((token: string) => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    const ready = offlineQueue.filter(i => i.nextRetryAt <= Date.now());
    if (ready.length === 0) {
      const soonest = Math.min(...offlineQueue.map(i => i.nextRetryAt));
      const delay = Math.max(1000, soonest - Date.now());
      retryTimerRef.current = setTimeout(() => scheduleRetry(token), delay);
      return;
    }
    const items = offlineQueue.splice(0, offlineQueue.length);
    for (const item of items) {
      if (item.nextRetryAt > Date.now()) {
        offlineQueue.push(item); // not ready yet, put back
        continue;
      }
      executeUploadInner(item.uri, item.fileName, item.fileType, token, item.connectionIds, item.id, item.retries, item.onDeleteLocal);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const executeUploadInner = useCallback(async (
    uri: string,
    fileName: string,
    fileType: "image" | "video",
    token: string,
    connectionIds: number[] | undefined,
    existingId: string,
    retries: number,
    onDeleteLocal?: () => Promise<void>
  ) => {
    updateUpload(existingId, { status: "uploading", progress: 0 });
    try {
      const result = await xhrUpload(uri, fileName, fileType, token, connectionIds, (pct) => {
        updateUpload(existingId, { progress: pct });
      });
      const status = (result.status as UploadStatus) || "done";
      const errors = result.results?.filter((r: any) => !r.success).map((r: any) => r.error).join("; ");
      updateUpload(existingId, { status, progress: 100, error: errors || undefined });

      if (status === "done" || status === "partial") {
        // Delete the local temp file after confirmed upload
        if (onDeleteLocal) {
          await onDeleteLocal().catch(() => {});
        } else {
          await deleteLocalFile(uri);
        }
      }
    } catch (err: any) {
      const isNetwork = err.message?.includes("Network") || err.message?.includes("network") || err.message?.includes("timed out");
      if (isNetwork && retries < MAX_RETRIES) {
        const delay = backoffMs(retries);
        offlineQueue.push({
          id: existingId, uri, fileName, fileType, connectionIds,
          retries: retries + 1, nextRetryAt: Date.now() + delay, onDeleteLocal,
        });
        updateUpload(existingId, {
          status: "queued",
          error: `Retrying in ${Math.round(delay / 1000)}s (attempt ${retries + 1}/${MAX_RETRIES})`,
        });
        scheduleRetry(token);
      } else {
        updateUpload(existingId, { status: "failed", error: err.message });
      }
    }
  }, [updateUpload, scheduleRetry]);

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
    const effectiveToken = token ?? tokenRef.current;

    const isOnline = Platform.OS !== "web" ? true : navigator.onLine;

    if (!effectiveToken || !isOnline) {
      offlineQueue.push({
        id, uri, fileName, fileType, connectionIds,
        retries: 0, nextRetryAt: Date.now(), onDeleteLocal,
      });
      updateUpload(id, { status: "queued", error: "Queued — will upload when online" });

      if (Platform.OS === "web" && "serviceWorker" in navigator) {
        const sw = await navigator.serviceWorker.ready.catch(() => null);
        if (sw && "sync" in sw) {
          (sw as any).sync.register("kkamera-upload-sync").catch(() => {});
        }
      }
      return;
    }

    await executeUploadInner(uri, fileName, fileType, effectiveToken, connectionIds, id, 0, onDeleteLocal);
  }, [addUpload, updateUpload, executeUploadInner]);

  const retryQueued = useCallback((token: string | null) => {
    const effectiveToken = token ?? tokenRef.current;
    if (!effectiveToken || offlineQueue.length === 0) return;
    scheduleRetry(effectiveToken);
  }, [scheduleRetry]);

  // Service worker retry messages
  useEffect(() => {
    if (Platform.OS !== "web" || !("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "RETRY_UPLOADS" || event.data?.type === "PERIODIC_SYNC") {
        retryQueued(tokenRef.current);
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, [retryQueued]);

  // Retry when coming back online
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const handler = () => retryQueued(tokenRef.current);
    window.addEventListener("online", handler);
    return () => window.removeEventListener("online", handler);
  }, [retryQueued]);

  const lastUpload = uploads[0] ?? null;

  const value = useMemo<UploadContextValue>(() => ({
    uploads, lastUpload, addUpload, updateUpload, clearCompleted, executeUpload, retryQueued,
  }), [uploads, lastUpload, addUpload, updateUpload, clearCompleted, executeUpload, retryQueued]);

  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}

export function useUpload() {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUpload must be used within UploadProvider");
  return ctx;
}
