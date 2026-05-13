import React, {
  createContext, useContext, useState, useCallback, useMemo,
  useRef, useEffect, type ReactNode,
} from "react";
import { Platform } from "react-native";

export type UploadStatus = "idle" | "queued" | "uploading" | "done" | "failed" | "partial";

export interface UploadEntry {
  id: string;
  fileName: string;
  fileType: string;
  status: UploadStatus;
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
    connectionIds?: number[]
  ) => Promise<void>;
  retryQueued: (token: string | null) => void;
}

const UploadContext = createContext<UploadContextValue | null>(null);

// Module-level store for queued uploads when offline
interface QueuedItem {
  id: string;
  uri: string;
  fileName: string;
  fileType: "image" | "video";
  connectionIds?: number[];
}
const offlineQueue: QueuedItem[] = [];

const BASE_URL = (process.env["EXPO_PUBLIC_DOMAIN"])
  ? `https://${process.env["EXPO_PUBLIC_DOMAIN"]}`
  : "";

async function fileUriToBlob(uri: string): Promise<Blob> {
  if (Platform.OS === "web") {
    // On web the URI is already a blob URL or data URI
    const res = await fetch(uri);
    return res.blob();
  }
  // React Native: fetch a local file URI
  const res = await fetch(uri);
  return res.blob();
}

async function doUpload(
  uri: string,
  fileName: string,
  fileType: "image" | "video",
  token: string,
  connectionIds?: number[]
): Promise<{ status: string; results: any[] }> {
  const blob = await fileUriToBlob(uri);
  const mimeType = fileType === "video" ? "video/mp4" : "image/jpeg";

  const formData = new FormData();
  formData.append("file", blob, fileName);
  formData.append("fileName", fileName);
  formData.append("mimeType", mimeType);
  if (connectionIds?.length) {
    formData.append("connectionIds", JSON.stringify(connectionIds));
  }

  const res = await fetch(`${BASE_URL}/api/uploads/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Upload failed: ${res.status} ${text}`);
  }
  return res.json();
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const tokenRef = useRef<string | null>(null);

  const addUpload = useCallback((fileName: string, fileType: string): string => {
    const id = Date.now().toString() + Math.random().toString(36).slice(2, 9);
    const entry: UploadEntry = { id, fileName, fileType, status: "uploading", timestamp: Date.now() };
    setUploads(prev => [entry, ...prev].slice(0, 50));
    return id;
  }, []);

  const updateUpload = useCallback((id: string, updates: Partial<UploadEntry>) => {
    setUploads(prev => prev.map(u => u.id === id ? { ...u, ...updates } : u));
  }, []);

  const clearCompleted = useCallback(() => {
    setUploads(prev => prev.filter(u => u.status !== "done"));
  }, []);

  const executeUpload = useCallback(async (
    uri: string,
    fileName: string,
    fileType: "image" | "video",
    token: string | null,
    connectionIds?: number[]
  ) => {
    const id = addUpload(fileName, fileType);
    if (token) tokenRef.current = token;
    const effectiveToken = token ?? tokenRef.current;

    // Check online status
    const isOnline = Platform.OS !== "web" || navigator.onLine;

    if (!effectiveToken || !isOnline) {
      // Queue offline
      offlineQueue.push({ id, uri, fileName, fileType, connectionIds });
      updateUpload(id, { status: "queued" });

      // Register background sync on web
      if (Platform.OS === "web" && "serviceWorker" in navigator) {
        const sw = await navigator.serviceWorker.ready.catch(() => null);
        if (sw && "sync" in sw) {
          (sw as any).sync.register("kkamera-upload-sync").catch(() => {});
        }
      }
      return;
    }

    try {
      const result = await doUpload(uri, fileName, fileType, effectiveToken, connectionIds);
      const status = (result.status as UploadStatus) || "done";
      const errors = result.results?.filter((r: any) => !r.success).map((r: any) => r.error).join("; ");
      updateUpload(id, { status, error: errors || undefined });
    } catch (err: any) {
      // Queue for retry if network error
      const isNetworkError = err.message?.includes("fetch") || err.message?.includes("network") || !navigator?.onLine;
      if (isNetworkError) {
        offlineQueue.push({ id, uri, fileName, fileType, connectionIds });
        updateUpload(id, { status: "queued", error: "Queued — will upload when online" });
      } else {
        updateUpload(id, { status: "failed", error: err.message });
      }
    }
  }, [addUpload, updateUpload]);

  const retryQueued = useCallback((token: string | null) => {
    const effectiveToken = token ?? tokenRef.current;
    if (!effectiveToken || offlineQueue.length === 0) return;
    const items = offlineQueue.splice(0, offlineQueue.length);
    for (const item of items) {
      executeUpload(item.uri, item.fileName, item.fileType, effectiveToken, item.connectionIds);
    }
  }, [executeUpload]);

  // Listen for service worker RETRY_UPLOADS message
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
