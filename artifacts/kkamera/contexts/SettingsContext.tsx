import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type GridType = "off" | "thirds" | "golden" | "square" | "diagonal";

export interface AppSettings {
  imageFormat: "jpeg" | "heic" | "png" | "webp";
  videoFormat: "mp4" | "mov" | "hevc";
  videoQuality: "1080p" | "4k" | "720p";
  uploadOnlyOnWifi: boolean;
  promptBeforeUpload: boolean;
  saveLocation: boolean;
  flashMode: "off" | "on" | "auto";
  showLevelGuide: boolean;
  mirrorFrontCamera: boolean;
  photoMarkup: boolean;
  markupUploadMode: "both" | "marked" | "original";
  recordHistory: boolean;
  // Pro camera controls
  gridType: GridType;
  timerSeconds: 0 | 3 | 10;
  timerBeep: boolean;
  burstCount: number;
  burstDelay: number;
  screenFlashSelfie: boolean;
  flipPreview: boolean;
  stampPhotos: boolean;
  stripExif: boolean;
  compassMeta: boolean;
  volumeKeyShutter: boolean;
  // Privacy & security
  appLockEnabled: boolean;
  appLockType: "biometric" | "pin";
  appPin: string;
  // Upload behaviour
  maxVideoDurationSeconds: 0 | 30 | 60 | 300;
  deleteLocalAfterUpload: boolean;
  // Witness mode
  witnessEmail: string;
  witnessOnSuccess: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  imageFormat: "jpeg",
  videoFormat: "mp4",
  videoQuality: "1080p",
  uploadOnlyOnWifi: false,
  promptBeforeUpload: false,
  saveLocation: true,
  flashMode: "auto",
  showLevelGuide: false,
  mirrorFrontCamera: false,
  photoMarkup: false,
  markupUploadMode: "both",
  recordHistory: true,
  gridType: "off",
  timerSeconds: 0,
  timerBeep: false,
  burstCount: 1,
  burstDelay: 1,
  screenFlashSelfie: true,
  flipPreview: false,
  stampPhotos: false,
  stripExif: false,
  compassMeta: false,
  volumeKeyShutter: true,
  appLockEnabled: false,
  appLockType: "biometric",
  appPin: "",
  maxVideoDurationSeconds: 0,
  deleteLocalAfterUpload: true,
  witnessEmail: "",
  witnessOnSuccess: false,
};

const SETTINGS_KEY = "kkamera_settings";

interface SettingsContextValue {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  isLoading: boolean;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY).then(stored => {
      if (stored) {
        try {
          setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(stored) });
        } catch { /* use defaults */ }
      }
      setIsLoading(false);
    });
  }, []);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const value = useMemo<SettingsContextValue>(() => ({
    settings, updateSetting, isLoading,
  }), [settings, updateSetting, isLoading]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
