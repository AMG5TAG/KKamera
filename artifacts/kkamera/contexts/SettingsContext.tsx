import React, { createContext, useContext, useState, useEffect, useMemo, useCallback, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_ZOOM, migrateStoredZoom, type ZoomValue } from "@/lib/zoomLevels";

export type GridType = "off" | "thirds" | "golden" | "square" | "diagonal";

export interface AppSettings {
  /** Bumped when stored values need migrating (see migrateSettings). */
  schemaVersion: number;
  // Photos are always JPEG; the container a video lands in is whatever the
  // platform recorder produces (.mov on iOS, .mp4 on Android). Only the codec
  // is selectable, and only iOS exposes it.
  videoCodec: "h264" | "hevc";
  videoQuality: "1080p" | "4k" | "720p";
  /** Also save every capture to the device photo library. */
  saveToCameraRoll: boolean;
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
  /** Zoom the rear camera opens at (and returns to when flipping back). */
  defaultZoom: ZoomValue;
  timerSeconds: 0 | 3 | 10;
  timerBeep: boolean;
  burstCount: number;
  burstDelay: number;
  /** INTERVAL mode: seconds between shots. */
  intervalSeconds: IntervalSeconds;
  /** INTERVAL mode: the series stops by itself after this many shots. */
  intervalMaxShots: IntervalMaxShots;
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
  // How long the "Uploaded" success badge stays on screen (0 = until next capture)
  uploadedBadgeSeconds: 0 | 3 | 5 | 10;
  // Witness mode
  witnessEmail: string;
  witnessOnSuccess: boolean;
}

export const INTERVAL_SECONDS_OPTIONS = [1, 2, 5, 10, 30, 60] as const;
export type IntervalSeconds = (typeof INTERVAL_SECONDS_OPTIONS)[number];
export const INTERVAL_MAX_SHOTS_OPTIONS = [10, 25, 50, 100, 250] as const;
export type IntervalMaxShots = (typeof INTERVAL_MAX_SHOTS_OPTIONS)[number];

const SCHEMA_VERSION = 2;

const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: SCHEMA_VERSION,
  videoCodec: "h264",
  videoQuality: "1080p",
  // Privacy-first for new installs: nothing goes to the photo library and no
  // GPS is embedded until the user opts in. Existing installs keep whatever
  // they had (see LEGACY_DEFAULTS in migrateSettings).
  saveToCameraRoll: false,
  uploadOnlyOnWifi: false,
  promptBeforeUpload: false,
  saveLocation: false,
  flashMode: "auto",
  showLevelGuide: false,
  mirrorFrontCamera: false,
  photoMarkup: false,
  markupUploadMode: "both",
  recordHistory: true,
  gridType: "off",
  defaultZoom: DEFAULT_ZOOM,
  timerSeconds: 0,
  timerBeep: false,
  burstCount: 1,
  burstDelay: 1,
  intervalSeconds: 2,
  intervalMaxShots: 100,
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
  uploadedBadgeSeconds: 5,
  witnessEmail: "",
  witnessOnSuccess: false,
};

const SETTINGS_KEY = "kkamera_settings";

/**
 * Defaults that changed after release. A stored blob comes from an existing
 * install, which ran with the OLD default, so a key missing from it is filled
 * from here rather than DEFAULT_SETTINGS — a privacy default flipping for new
 * installs must never silently change an existing user's behaviour.
 */
const LEGACY_DEFAULTS: Partial<AppSettings> = {
  saveToCameraRoll: true,
  saveLocation: true,
};

/**
 * Upgrade a stored settings blob to the current schema.
 * v1 → v2: the fake photo-format option (HEIC/PNG/WebP were only file-name
 * extensions on JPEG bytes) and the rename-only video-format option are gone;
 * a stored "hevc" video format becomes the real HEVC codec choice. Default zoom
 * moved from mislabelled focal-length stops to normalised zoom (0 = true 1×).
 */
function migrateSettings(stored: Record<string, unknown>): AppSettings {
  const legacy = stored.schemaVersion !== SCHEMA_VERSION;
  const { imageFormat: _imageFormat, videoFormat, ...rest } = stored;
  const next = { ...DEFAULT_SETTINGS, ...LEGACY_DEFAULTS, ...rest } as AppSettings;
  if (legacy && videoFormat === "hevc" && stored.videoCodec == null) next.videoCodec = "hevc";
  if (next.videoCodec !== "h264" && next.videoCodec !== "hevc") next.videoCodec = "h264";
  next.defaultZoom = migrateStoredZoom(stored.defaultZoom ?? DEFAULT_ZOOM, legacy && "defaultZoom" in stored);
  if (!(INTERVAL_SECONDS_OPTIONS as readonly number[]).includes(next.intervalSeconds)) {
    next.intervalSeconds = DEFAULT_SETTINGS.intervalSeconds;
  }
  if (!(INTERVAL_MAX_SHOTS_OPTIONS as readonly number[]).includes(next.intervalMaxShots)) {
    next.intervalMaxShots = DEFAULT_SETTINGS.intervalMaxShots;
  }
  next.schemaVersion = SCHEMA_VERSION;
  return next;
}

interface SettingsContextValue {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  /** Restore all settings to defaults (clears the app-lock PIN) — used by Panic Wipe. */
  resetSettings: () => Promise<void>;
  isLoading: boolean;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY)
      .then(stored => {
        if (stored) {
          try {
            const migrated = migrateSettings(JSON.parse(stored));
            setSettings(migrated);
            AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(migrated)).catch(() => {});
          } catch { /* use defaults */ }
        }
      })
      // A storage read failure falls back to defaults — never leave isLoading
      // stuck (it gates camera zoom init and the app-lock decision).
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const resetSettings = useCallback(async () => {
    setSettings(DEFAULT_SETTINGS);
    await AsyncStorage.removeItem(SETTINGS_KEY).catch(() => {});
  }, []);

  const value = useMemo<SettingsContextValue>(() => ({
    settings, updateSetting, resetSettings, isLoading,
  }), [settings, updateSetting, resetSettings, isLoading]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
