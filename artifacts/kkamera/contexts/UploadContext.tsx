import React, { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";

export type UploadStatus = "idle" | "uploading" | "done" | "failed" | "queued";

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
}

const UploadContext = createContext<UploadContextValue | null>(null);

export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploads, setUploads] = useState<UploadEntry[]>([]);

  const addUpload = useCallback((fileName: string, fileType: string): string => {
    const id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
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

  const lastUpload = uploads[0] ?? null;

  const value = useMemo<UploadContextValue>(() => ({
    uploads, lastUpload, addUpload, updateUpload, clearCompleted,
  }), [uploads, lastUpload, addUpload, updateUpload, clearCompleted]);

  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}

export function useUpload() {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUpload must be used within UploadProvider");
  return ctx;
}
