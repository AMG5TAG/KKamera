import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
  Animated, Easing, StatusBar, Alert, ScrollView, Modal, Image,
  useWindowDimensions, Linking,
} from "react-native";
import * as Speech from "expo-speech";
import * as Location from "expo-location";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons, Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  CameraView, CameraType, CameraMode, useCameraPermissions, useMicrophonePermissions,
  type VideoCodec, type VideoQuality,
} from "expo-camera";
import { useAuth } from "@/contexts/AuthContext";
import { useUpload } from "@/contexts/UploadContext";
import { useSettings, type GridType } from "@/contexts/SettingsContext";
import { useSubscription } from "@/lib/revenuecat";
import { useGetSubscription, useListCloudConnections } from "@workspace/api-client-react";
import Svg, { Line, Rect, G } from "react-native-svg";
import { captureRef } from "react-native-view-shot";
import { TrialBanner } from "@/components/TrialBanner";
import { API_BASE_URL } from "@/lib/config";
import { resolveUploadTarget } from "@/lib/uploadTarget";
import { useUploadTargetResolver } from "@/lib/useUploadTargetResolver";
import {
  readCachedSubscription, writeCachedSubscription, subscriptionAllows, type SubscriptionSnapshot,
} from "@/lib/offlineCache";
import { saveToCameraRoll, deleteTempFile, extensionOf } from "@/lib/captureStorage";
import {
  accumulateSweep, panoLayout, type PanoLayout,
  PANO_STEP_DEG, PANO_MAX_SWEEP_DEG, PANO_MAX_FRAMES, PANO_MIN_FRAMES,
  PANO_FALLBACK_INTERVAL_MS,
} from "@/lib/panorama";
import {
  ZOOM_LEVELS, DEFAULT_ZOOM, FRONT_CAMERA_ZOOM, ULTRA_WIDE_LENS_PATTERN, zoomLabel,
} from "@/lib/zoomLevels";
import { cloudAppTarget, pickCloudConnection } from "@/lib/cloudApps";

function GridOverlay({ type }: { type: GridType }) {
  const stroke = "rgba(255,255,255,0.45)";
  const sw = 0.6;
  return (
    <Svg
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      width="100%"
      height="100%"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <G>
        {type === "thirds" && (
          <>
            <Line x1="33.33" y1="0" x2="33.33" y2="100" stroke={stroke} strokeWidth={sw} />
            <Line x1="66.67" y1="0" x2="66.67" y2="100" stroke={stroke} strokeWidth={sw} />
            <Line x1="0" y1="33.33" x2="100" y2="33.33" stroke={stroke} strokeWidth={sw} />
            <Line x1="0" y1="66.67" x2="100" y2="66.67" stroke={stroke} strokeWidth={sw} />
          </>
        )}
        {type === "golden" && (
          <>
            <Line x1="38.2" y1="0" x2="38.2" y2="100" stroke={stroke} strokeWidth={sw} />
            <Line x1="61.8" y1="0" x2="61.8" y2="100" stroke={stroke} strokeWidth={sw} />
            <Line x1="0" y1="38.2" x2="100" y2="38.2" stroke={stroke} strokeWidth={sw} />
            <Line x1="0" y1="61.8" x2="100" y2="61.8" stroke={stroke} strokeWidth={sw} />
          </>
        )}
        {type === "square" && (
          <Rect x="0" y="12.5" width="100" height="75" fill="none" stroke={stroke} strokeWidth={sw} />
        )}
        {type === "diagonal" && (
          <>
            <Line x1="0" y1="0" x2="100" y2="100" stroke={stroke} strokeWidth={sw} />
            <Line x1="100" y1="0" x2="0" y2="100" stroke={stroke} strokeWidth={sw} />
          </>
        )}
      </G>
    </Svg>
  );
}

const PRIMARY = "#b19870";

// Lazy import so expo-sensors is never loaded on web (import-time crash)
async function getAccelerometer() {
  if (Platform.OS === "web") return null;
  const { Accelerometer } = await import("expo-sensors");
  return Accelerometer;
}

// Yaw source for the panorama sweep. DeviceMotion carries an integrated
// orientation (rotation.alpha), which is far steadier than the raw magnetometer
// used for the compass badge.
async function getDeviceMotion() {
  if (Platform.OS === "web") return null;
  const { DeviceMotion } = await import("expo-sensors");
  return DeviceMotion;
}

// Native-only document scanner (iOS VisionKit / Android ML Kit). The module
// registers a TurboModule at import time and throws on web, so it must only be
// imported lazily on native — never at the top level.
async function getDocumentScanner() {
  if (Platform.OS === "web") return null;
  return await import("react-native-document-scanner-plugin");
}

// Tilt within this many degrees of horizontal counts as "level" → green guide.
const LEVEL_TOLERANCE_DEG = 2;

type FlashMode = "off" | "on" | "auto";
// "timelapse" is shown to the user as INTERVAL: it takes a photo every
// INTERVAL_SECONDS and uploads the series of stills — it does not render a video.
type ExtMode = "photo" | "video" | "timelapse" | "pano" | "scan";

interface ModeConfig { mode: ExtMode; label: string; cameraMode: CameraMode; isVideo: boolean }

const EXT_MODES: ModeConfig[] = [
  { mode: "photo",     label: "PHOTO",    cameraMode: "picture", isVideo: false },
  { mode: "video",     label: "VIDEO",    cameraMode: "video",   isVideo: true  },
  { mode: "timelapse", label: "INTERVAL", cameraMode: "picture", isVideo: false },
  { mode: "pano",      label: "PANO",     cameraMode: "picture", isVideo: false },
  { mode: "scan",      label: "SCAN",     cameraMode: "picture", isVideo: false },
];

/** Seconds between shots in INTERVAL (time-lapse) mode. */
const INTERVAL_SECONDS = 2;

const VIDEO_QUALITY: Record<"720p" | "1080p" | "4k", VideoQuality> = {
  "720p": "720p", "1080p": "1080p", "4k": "2160p",
};
const VIDEO_CODEC: Record<"h264" | "hevc", VideoCodec> = { h264: "avc1", hevc: "hvc1" };

/** A GPS fix older than this is not written into a photo. */
const MAX_FIX_AGE_MS = 2 * 60 * 1000;

/** EXIF GPS date/time stamps are UTC: "YYYY:MM:DD" and "HH:MM:SS". */
function gpsStamps(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCFullYear()}:${p(d.getUTCMonth() + 1)}:${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  };
}

/**
 * Normalise a react-native-view-shot tmpfile result to a file:// uri.
 */
function toFileUri(result: string): string {
  return result.startsWith("file:") || result.startsWith("content:")
    ? result
    : result.startsWith("/") ? `file://${result}` : result;
}

// Each filter carries a real color-grade (CSS filter string) that is applied to
// the web preview AND baked into the saved photo, plus a subtle tint overlay used
// to approximate the look in the native preview (where GPU grading isn't available).
interface FilterDef {
  name: string;
  css: string | null;                       // web preview + capture grade
  swatch: string;                           // thumbnail colour
  overlay: { color: string; opacity: number } | null; // native preview approximation
  isBeauty: boolean;
}
const FILTERS: FilterDef[] = [
  { name: "None",      css: null, swatch: "#2a2a2a", overlay: null, isBeauty: false },
  { name: "Vivid",     css: "saturate(1.5) contrast(1.12) brightness(1.03)",                 swatch: "#ff6b35", overlay: { color: "#ff6b35", opacity: 0.07 }, isBeauty: false },
  { name: "Warm",      css: "sepia(0.28) saturate(1.3) brightness(1.04) hue-rotate(-8deg)",  swatch: "#f59e0b", overlay: { color: "#f59e0b", opacity: 0.10 }, isBeauty: false },
  { name: "Cool",      css: "saturate(1.08) contrast(1.06) brightness(1.02) hue-rotate(14deg)", swatch: "#60a5fa", overlay: { color: "#60a5fa", opacity: 0.10 }, isBeauty: false },
  { name: "B&W",       css: "grayscale(1) contrast(1.15) brightness(1.03)",                  swatch: "#888888", overlay: { color: "#000000", opacity: 0.12 }, isBeauty: false },
  { name: "Fade",      css: "contrast(0.82) brightness(1.1) saturate(0.82) sepia(0.1)",      swatch: "#d4c5b0", overlay: { color: "#d4c5b0", opacity: 0.12 }, isBeauty: false },
  { name: "Noir",      css: "grayscale(1) contrast(1.5) brightness(0.92)",                   swatch: "#1a1a1a", overlay: { color: "#000000", opacity: 0.18 }, isBeauty: false },
  { name: "Beauty",    css: "brightness(1.07) saturate(1.06) contrast(0.97) blur(0.4px)",    swatch: "#ffb7c5", overlay: { color: "#ffb7c5", opacity: 0.07 }, isBeauty: true  },
  { name: "Smooth",    css: "brightness(1.06) saturate(0.98) contrast(0.96) sepia(0.05) blur(0.6px)", swatch: "#f0e6d3", overlay: { color: "#f0e6d3", opacity: 0.07 }, isBeauty: true  },
  { name: "Glow",      css: "brightness(1.12) saturate(1.1) contrast(0.95) blur(0.5px)",     swatch: "#fff9c4", overlay: { color: "#fff9c4", opacity: 0.07 }, isBeauty: true  },
  { name: "Porcelain", css: "brightness(1.09) saturate(0.9) contrast(0.98) hue-rotate(4deg) blur(0.5px)", swatch: "#dfe8f0", overlay: { color: "#dfe8f0", opacity: 0.07 }, isBeauty: true  },
];


// iOS Camera-style ordered strip: PANO · VIDEO · PHOTO · DOC · INTERVAL
const STRIP_MODES: ModeConfig[] = [
  EXT_MODES.find(m => m.mode === "pano")!,
  EXT_MODES.find(m => m.mode === "video")!,
  EXT_MODES.find(m => m.mode === "photo")!,
  EXT_MODES.find(m => m.mode === "scan")!,
  EXT_MODES.find(m => m.mode === "timelapse")!,
];
const STRIP_LABEL: Partial<Record<ExtMode, string>> = {
  scan: "DOC", timelapse: "INTERVAL",
};
const DEFAULT_STRIP_IDX = STRIP_MODES.findIndex(m => m.mode === "photo"); // 2
const ITEM_W = 88;

// Offscreen composition passed to react-native-view-shot for native photo
// baking (stamp burn-in + filter tint). Sizes are pre-computed (capped) so the
// same values drive both the rendered view and the captureRef output.
interface BakeConfig {
  uri: string;
  renderW: number;
  renderH: number;
  pad: number;
  fs: number;
  stampLines: string[];
  overlay: { color: string; opacity: number } | null;
}

interface PanoFrame { uri: string; width: number; height: number }

// Offscreen strip composition for PANO, rasterised the same way as BakeConfig.
interface PanoConfig extends PanoLayout { frames: PanoFrame[] }

export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
  const { token, user } = useAuth();
  const userId = user?.id ?? null;
  const { lastUpload, executeUpload } = useUpload();
  const { settings, updateSetting, isLoading: settingsLoading } = useSettings();
  const { data: sub, isLoading: subLoading, isError: subError } = useGetSubscription();
  const rcSub = useSubscription();
  // Resolves the user's upload destination; offline it uses the last target
  // seen for this user and never widens a "none"/"selected" choice to "all".
  const { uploadTarget, getUploadTarget } = useUploadTargetResolver();
  const { data: cloudConnections } = useListCloudConnections();

  // Last server subscription seen for this user, so a cold start with no
  // network (the query errors) doesn't lock out a user whose access is still
  // valid by date. `undefined` = cache not read yet.
  const [cachedSub, setCachedSub] = useState<SubscriptionSnapshot | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setCachedSub(undefined);
    readCachedSubscription(userId).then(v => { if (!cancelled) setCachedSub(v); });
    return () => { cancelled = true; };
  }, [userId]);
  useEffect(() => {
    if (!sub || userId == null) return;
    const snap: SubscriptionSnapshot = {
      status: sub.status,
      trialEnd: sub.trialEnd ?? null,
      currentPeriodEnd: sub.currentPeriodEnd ?? null,
    };
    setCachedSub(snap);
    void writeCachedSubscription(userId, snap);
  }, [sub, userId]);

  // Gate the camera UI on a real entitlement, using the same rule the server
  // applies to /uploads/execute (lib/offlineCache.ts → subscriptionAllows):
  // cancelled keeps access until the paid period ends, past_due only within
  // the grace window. When the server can't be reached we fall back to the
  // cached subscription; with nothing cached we allow capture — the server
  // still enforces access and the upload queue parks refused (402) uploads, so
  // nothing shot while access is unknown is lost. On native, a RevenueCat
  // (App Store / Play) entitlement also grants access so IAP payers aren't
  // paywalled before the RevenueCat webhook reconciles the server row.
  const accessUnknown = subLoading || (subError && !sub);
  const hasAccess =
    (sub ? subscriptionAllows(sub) : false)
    || (accessUnknown && (cachedSub === undefined || cachedSub === null || subscriptionAllows(cachedSub)))
    || (Platform.OS !== "web" && rcSub.isSubscribed);

  const trialDaysLeft = sub?.status === "trial" && sub?.trialEnd
    ? Math.max(0, Math.ceil((new Date(sub.trialEnd).getTime() - Date.now()) / 86400000))
    : null;

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const [extMode, setExtMode] = useState<ExtMode>("photo");
  const [facing, setFacing] = useState<CameraType>("back");
  const [flash, setFlash] = useState<FlashMode>("auto");
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  const [isRecording, setIsRecording] = useState(false);
  const [selectedFilter, setSelectedFilter] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  // Double-tap guards. Refs, not state: two taps inside one render would both
  // see a stale `false` from state. `busyRef` only covers the shutter itself
  // (countdown + takePicture + bake) — uploads run in the background.
  const busyRef = useRef(false);
  const recordingRef = useRef(false);
  const recordStopping = useRef(false);

  // iOS only: the physical ultra-wide lens, when the device has one. The
  // normalised `zoom` prop can't go wider than the main lens's 1×, so a real
  // 0.5× means switching `selectedLens`.
  const [ultraWideLens, setUltraWideLens] = useState<string | null>(null);
  const [ultraWideSelected, setUltraWideSelected] = useState(false);

  // Location for GPS EXIF / stamp. A watch keeps the latest fix in a ref so
  // the shutter never waits on a GPS lookup.
  const [locationGranted, setLocationGranted] = useState<boolean | null>(null);
  const lastFix = useRef<Location.LocationObject | null>(null);

  // Time-lapse state
  const [isTimelapsing, setIsTimelapsing] = useState(false);
  const [tlCount, setTlCount] = useState(0);
  const tlTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tlPhotos = useRef<string[]>([]);
  const tlGrabbing = useRef(false);

  // Recording timer
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Scan result
  const [scanUri, setScanUri] = useState<string | null>(null);
  const [scanFileName, setScanFileName] = useState("");
  const [showScanModal, setShowScanModal] = useState(false);
  const [scanCropped, setScanCropped] = useState(false);
  const [isProcessingScan, setIsProcessingScan] = useState(false);

  // Mode strip scroll ref
  const modeScrollRef = useRef<ScrollView>(null);
  // Stable initial offset — a fresh object here would make web re-apply it on
  // every render, snapping the strip back to default whenever the mode changes.
  const stripContentOffset = useRef({ x: DEFAULT_STRIP_IDX * ITEM_W, y: 0 }).current;
  // Guards mode-strip scrolls we trigger ourselves (taps / sync) so the
  // scroll-end handler doesn't echo them back into another setExtMode.
  const programmaticScroll = useRef(false);
  const programmaticClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Zoom collapse
  const [zoomExpanded, setZoomExpanded] = useState(false);
  const zoomCollapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pro-camera state
  const [countdown, setCountdown] = useState<number | null>(null);
  const [screenFlashing, setScreenFlashing] = useState(false);
  const [heading, setHeading] = useState<number | null>(null);
  const [stampToast, setStampToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, ms = 1800) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setStampToast(msg);
    toastTimer.current = setTimeout(() => setStampToast(null), ms);
  }, []);

  const cameraRef = useRef<CameraView>(null);
  const captureScale = useRef(new Animated.Value(1)).current;
  const screenFlashOpacity = useRef(new Animated.Value(0)).current;
  const baseZoom = useRef<number>(DEFAULT_ZOOM);

  // Native photo-baking (stamp burn-in + filter tint) via react-native-view-shot.
  const [bakeConfig, setBakeConfig] = useState<BakeConfig | null>(null);
  const bakeViewRef = useRef<View>(null);
  const bakeResolver = useRef<((uri: string | null) => void) | null>(null);
  const bakeCaptured = useRef(false);

  // ── Panorama sweep ────────────────────────────────────────────────────────
  const [isPanoCapturing, setIsPanoCapturing] = useState(false);
  const [panoComposing, setPanoComposing] = useState(false);
  const [panoSweep, setPanoSweep] = useState(0);      // degrees swept so far
  const [panoFrameCount, setPanoFrameCount] = useState(0);
  // Refs shadow the state above because the sensor callback and the capture
  // loop both run outside React's render cycle and need the live values.
  const panoActive = useRef(false);
  const panoFrames = useRef<PanoFrame[]>([]);
  const panoSweepRef = useRef(0);
  const panoLastYaw = useRef<number | null>(null);
  const panoNextCaptureAt = useRef(0);
  const panoGrabbing = useRef(false);
  const panoSensorSub = useRef<{ remove: () => void } | null>(null);
  const panoWebHandler = useRef<((e: any) => void) | null>(null);
  const panoTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishPanoRef = useRef<() => void>(() => {});
  // Offscreen strip composition.
  const [panoConfig, setPanoConfig] = useState<PanoConfig | null>(null);
  const panoViewRef = useRef<View>(null);
  const panoResolver = useRef<((uri: string | null) => void) | null>(null);
  const panoCaptured = useRef(false);
  const panoSettled = useRef(0);

  useEffect(() => {
    if (!cameraPermission?.granted) requestCameraPermission();
    if (!micPermission?.granted) requestMicPermission();
  }, []);

  // Apply the user's default zoom. Settings arrive asynchronously from
  // AsyncStorage, so the initial useState value is only the built-in default —
  // this runs once the stored value has loaded, and again if the preference is
  // changed. It deliberately does NOT depend on `zoom`, so a pinch or a tap on
  // the zoom rail stays put for the rest of the session.
  useEffect(() => {
    if (settingsLoading || facing !== "back") return;
    setUltraWideSelected(false);
    setZoom(settings.defaultZoom);
    baseZoom.current = settings.defaultZoom;
  }, [settingsLoading, settings.defaultZoom, facing]);

  // Location permission + a low-power position watch while GPS tagging is on.
  // Asked on camera mount (and whenever the setting is switched on) so the
  // permission prompt comes before the first shot, not in the middle of one.
  // Denied → photos are simply saved without GPS; the settings screen shows
  // why in the toggle's hint.
  useEffect(() => {
    if (settingsLoading) return;
    if (!settings.saveLocation) { lastFix.current = null; return; }
    let cancelled = false;
    let watch: { remove: () => void } | null = null;
    (async () => {
      try {
        let perm = await Location.getForegroundPermissionsAsync();
        if (!perm.granted && perm.canAskAgain) perm = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        setLocationGranted(perm.granted);
        if (!perm.granted) return;
        const last = await Location.getLastKnownPositionAsync({ maxAge: MAX_FIX_AGE_MS }).catch(() => null);
        if (last && !cancelled && !lastFix.current) lastFix.current = last;
        const created = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, distanceInterval: 10, timeInterval: 5000 },
          pos => { lastFix.current = pos; },
        );
        if (cancelled) created.remove();
        else watch = created;
      } catch { /* location services unavailable — capture without GPS */ }
    })();
    return () => { cancelled = true; watch?.remove(); };
  }, [settingsLoading, settings.saveLocation]);

  // Compass bearing (badge, stamp and GPSImgDirection). Location's heading
  // API fuses magnetometer + gyro and gives a true-north heading when a fix
  // is available — unlike a raw magnetometer atan2, which ignores tilt and
  // declination.
  const headingRef = useRef<{ deg: number; ref: "T" | "M" } | null>(null);
  useEffect(() => {
    if (!settings.compassMeta || Platform.OS === "web") { setHeading(null); headingRef.current = null; return; }
    let sub: { remove: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const created = await Location.watchHeadingAsync(h => {
          const isTrue = h.trueHeading != null && h.trueHeading >= 0;
          const deg = isTrue ? h.trueHeading : h.magHeading;
          if (deg == null || deg < 0) return;
          headingRef.current = { deg, ref: isTrue ? "T" : "M" };
          const rounded = Math.round(deg) % 360;
          setHeading(prev => (prev === rounded ? prev : rounded));
        });
        if (cancelled) created.remove();
        else sub = created;
      } catch { /* no compass on this device */ }
    })();
    return () => { cancelled = true; sub?.remove(); };
  }, [settings.compassMeta, locationGranted]);

  // Spirit-level tilt (roll) — drives the on-screen level guide.
  const [levelRoll, setLevelRoll] = useState(0);
  const lastRoll = useRef(0);
  useEffect(() => {
    if (!settings.showLevelGuide) { setLevelRoll(0); lastRoll.current = 0; return; }
    const pushRoll = (roll: number) => {
      // Fold to the deviation from upright so "level" reads ~0° regardless of
      // which way the device's Y axis points. Held upright to shoot, gravity
      // gives atan2(x,y) ≈ ±180° at level on some platforms — without this fold
      // the guide would never reach 0° and never turn green.
      if (roll > 90) roll -= 180;
      else if (roll < -90) roll += 180;
      // Round to whole degrees and only re-render on a real change to avoid
      // re-rendering the camera tree on every sensor tick.
      const r = Math.round(roll);
      if (r !== lastRoll.current) { lastRoll.current = r; setLevelRoll(r); }
    };

    if (Platform.OS === "web") {
      // gamma is the left↔right tilt of the device in degrees (0 = level).
      const handler = (e: any) => {
        if (e?.gamma == null) return;
        pushRoll(e.gamma);
      };
      window.addEventListener("deviceorientation", handler);
      return () => window.removeEventListener("deviceorientation", handler);
    }

    let sub: { remove: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const Accelerometer = await getAccelerometer();
        if (!Accelerometer || cancelled) return;
        const available = await Accelerometer.isAvailableAsync().catch(() => false);
        if (!available || cancelled) return;
        Accelerometer.setUpdateInterval(100);
        const created = Accelerometer.addListener(({ x, y }) => {
          // Roll around the screen-normal axis; 0° when held upright/level.
          pushRoll(Math.atan2(x, y) * (180 / Math.PI));
        });
        if (cancelled) created.remove();
        else sub = created;
      } catch { /* sensor unavailable */ }
    })();
    return () => { cancelled = true; sub?.remove(); };
  }, [settings.showLevelGuide]);

  // Give a light haptic tick the moment the guide snaps to level.
  const wasLevel = useRef(false);
  useEffect(() => {
    if (!settings.showLevelGuide) { wasLevel.current = false; return; }
    const level = Math.abs(levelRoll) <= LEVEL_TOLERANCE_DEG;
    if (level && !wasLevel.current && Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    wasLevel.current = level;
  }, [levelRoll, settings.showLevelGuide]);

  // Toggle the level guide. On iOS web, motion/orientation access must be
  // requested from inside a user gesture (this tap) before events will fire.
  const toggleLevelGuide = useCallback(async () => {
    const next = !settings.showLevelGuide;
    if (next && Platform.OS === "web") {
      try {
        const DOE: any = (globalThis as any).DeviceOrientationEvent;
        if (DOE && typeof DOE.requestPermission === "function") {
          await DOE.requestPermission();
        }
      } catch { /* denied or unsupported — guide just stays flat */ }
    }
    updateSetting("showLevelGuide", next);
  }, [settings.showLevelGuide, updateSetting]);

  // Web volume keys / spacebar shutter — use a ref so we don't re-bind every render
  const handleCaptureRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (Platform.OS !== "web" || !settings.volumeKeyShutter) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space" || e.key === "VolumeUp" || e.key === "VolumeDown" || e.key === "AudioVolumeUp" || e.key === "AudioVolumeDown") {
        e.preventDefault();
        handleCaptureRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settings.volumeKeyShutter]);

  // Mark the next scroll-settle as self-triggered so handleModeScrollEnd ignores
  // it. Auto-clears so a later genuine drag is never wrongly suppressed.
  const markProgrammaticScroll = useCallback(() => {
    programmaticScroll.current = true;
    if (programmaticClearTimer.current) clearTimeout(programmaticClearTimer.current);
    programmaticClearTimer.current = setTimeout(() => { programmaticScroll.current = false; }, 400);
  }, []);

  // Scroll strip to the currently active mode
  useEffect(() => {
    const idx = STRIP_MODES.findIndex(m => m.mode === extMode);
    if (idx >= 0) {
      const t = setTimeout(() => {
        markProgrammaticScroll();
        modeScrollRef.current?.scrollTo({ x: idx * ITEM_W, animated: true });
      }, 60);
      return () => clearTimeout(t);
    }
  }, [extMode, markProgrammaticScroll]);

  const currentModeConfig = EXT_MODES.find(m => m.mode === extMode) ?? EXT_MODES[0]!;
  const cameraViewMode: CameraMode = currentModeConfig.cameraMode;

  // Pinch to zoom
  const saveBaseZoom = useCallback(() => { baseZoom.current = zoom; }, [zoom]);
  const applyZoom = useCallback((scale: number) => {
    setZoom(z => Math.min(1, Math.max(0, baseZoom.current + (scale - 1) * 0.4)));
  }, []);

  const pinchGesture = Gesture.Pinch()
    .onStart(() => { runOnJS(saveBaseZoom)(); })
    .onUpdate((e) => { runOnJS(applyZoom)(e.scale); })
    .onEnd(() => { runOnJS(saveBaseZoom)(); });

  const confirmUpload = useCallback((): Promise<boolean> => {
    if (!settings.promptBeforeUpload) return Promise.resolve(true);
    return new Promise(resolve => {
      Alert.alert("Upload to Cloud?", "Send this file to your connected cloud storage?", [
        { text: "Skip", style: "cancel", onPress: () => resolve(false) },
        { text: "Upload", onPress: () => resolve(true) },
      ]);
    });
  }, [settings.promptBeforeUpload]);

  const notifyWitness = useCallback(async (fileName: string) => {
    if (!settings.witnessOnSuccess || !settings.witnessEmail || !token) return;
    fetch(`${API_BASE_URL}/api/uploads/witness-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ witnessEmail: settings.witnessEmail, fileName }),
    }).catch(() => {});
  }, [settings.witnessOnSuccess, settings.witnessEmail, token]);

  /**
   * Hand a finished capture off: a copy to the photo library (when enabled, or
   * always for the "Don't upload" target), then the upload queue. Callers
   * `void` this — it may wait on the upload-target lookup or a confirm prompt,
   * and the shutter must not. The queue persists the file, applies the
   * Wi-Fi-only rule itself and retries later, so nothing is dropped here.
   */
  const doUpload = useCallback(async (uri: string, fileName: string, type: "image" | "video") => {
    try {
      const target = await getUploadTarget();
      const wantRoll = Platform.OS !== "web" && (settings.saveToCameraRoll || target.skip);
      const roll = wantRoll ? await saveToCameraRoll(uri) : null;

      if (target.skip) {
        // "Don't upload": the photo library is the only destination.
        if (roll === "saved") {
          deleteTempFile(uri);
          showToast("Saved to Photos — cloud upload off");
        } else if (roll === "denied") {
          showToast("Not saved — allow Photos access for KKamera", 2800);
        } else {
          showToast(Platform.OS === "web"
            ? "Cloud upload off — capture not kept"
            : "Cloud upload off — couldn't save to Photos", 2800);
        }
        return;
      }
      if (roll === "denied") showToast("Photos access off — uploading only", 2200);

      const confirmed = await confirmUpload();
      if (!confirmed) {
        // Skipped: keep the temp file only if it isn't safe in the library.
        if (roll === "saved") deleteTempFile(uri);
        return;
      }

      // Without a callback the upload queue deletes the capture once it's
      // confirmed uploaded; a no-op keeps it when the user has turned that off.
      const onDeleteLocal = settings.deleteLocalAfterUpload ? undefined : async () => {};

      if (type === "image" && settings.photoMarkup) {
        router.push({ pathname: "/markup", params: { uri, fileName } });
        // The markup screen performs the actual upload; still notify the witness
        // here (fire-and-forget, same as the direct path) so marked-up captures
        // aren't silently exempt from witness notifications.
        notifyWitness(fileName);
      } else {
        // executeUpload persists the capture into the queue and returns
        // quickly; the network transfer continues in the background.
        executeUpload(uri, fileName, type, token, target.ids, onDeleteLocal)
          .then(() => notifyWitness(fileName))
          .catch(() => {});
      }
    } catch (err: any) {
      Alert.alert("Save Failed", err?.message ?? "Could not hand this capture to the upload queue.");
    }
  }, [getUploadTarget, confirmUpload, settings.photoMarkup, settings.deleteLocalAfterUpload, settings.saveToCameraRoll, executeUpload, token, notifyWitness, showToast]);

  const pulseCaptureBtn = () => {
    Animated.sequence([
      Animated.timing(captureScale, { toValue: 0.88, duration: 80, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(captureScale, { toValue: 1, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
  };

  // Run a self-timer countdown (with optional voice/beep)
  const runCountdown = useCallback(async (seconds: number) => {
    for (let s = seconds; s > 0; s--) {
      setCountdown(s);
      if (settings.timerBeep) {
        try {
          if (Platform.OS === "web" && typeof window !== "undefined" && "speechSynthesis" in window) {
            const u = new SpeechSynthesisUtterance(String(s));
            u.rate = 1.4; u.volume = 1;
            window.speechSynthesis.speak(u);
          } else {
            Speech.speak(String(s), { rate: 1.4 });
          }
        } catch { /* ignore tts errors */ }
      }
      if (Platform.OS !== "web") {
        try { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch { /* */ }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    setCountdown(null);
  }, [settings.timerBeep]);

  // Selfie screen flash: a full-white overlay that lights the subject. It must
  // stay up for the whole exposure, so it's raised before takePictureAsync and
  // only lowered once that resolves (screenFlashOff). Resolves true when the
  // flash is up.
  const screenFlashOn = useCallback(async (): Promise<boolean> => {
    if (!settings.screenFlashSelfie || facing !== "front") return false;
    setScreenFlashing(true);
    screenFlashOpacity.setValue(0);
    await new Promise<void>(resolve => {
      Animated.timing(screenFlashOpacity, { toValue: 1, duration: 90, useNativeDriver: true })
        .start(() => resolve());
    });
    // Give auto-exposure a moment to adapt to the lit face.
    await new Promise(r => setTimeout(r, 120));
    return true;
  }, [settings.screenFlashSelfie, facing, screenFlashOpacity]);

  const screenFlashOff = useCallback(() => {
    Animated.timing(screenFlashOpacity, { toValue: 0, duration: 180, useNativeDriver: true })
      .start(() => setScreenFlashing(false));
  }, [screenFlashOpacity]);

  // Bake a stamp overlay and/or filter tint into the captured photo on native.
  // takePictureAsync returns the raw frame (no preview overlays), so we compose
  // an offscreen <View> — the image plus a tint overlay and/or the stamp text —
  // and rasterise it to a new JPEG file with react-native-view-shot's captureRef.
  // Resolves to the baked file uri, or null if the capture failed (caller then
  // keeps the original uri and does NOT claim the stamp was applied).
  const bakeImageNative = useCallback((opts: {
    uri: string;
    width: number;
    height: number;
    stampLines: string[];
    overlay: { color: string; opacity: number } | null;
  }): Promise<string | null> => {
    // Cap the composition's long edge so the offscreen render stays within a
    // sane memory/time budget. Tradeoff: very high-res photos are downscaled to
    // ~2048px on their long edge when a stamp/filter is baked in.
    const MAX_EDGE = 2048;
    const w = opts.width > 0 ? opts.width : 1080;
    const h = opts.height > 0 ? opts.height : 1440;
    const long = Math.max(w, h);
    const scale = long > MAX_EDGE ? MAX_EDGE / long : 1;
    const renderW = Math.max(1, Math.round(w * scale));
    const renderH = Math.max(1, Math.round(h * scale));
    bakeCaptured.current = false;
    return new Promise((resolve) => {
      bakeResolver.current = resolve;
      setBakeConfig({
        uri: opts.uri,
        renderW,
        renderH,
        pad: Math.round(renderW * 0.025),
        fs: Math.round(renderW * 0.028),
        stampLines: opts.stampLines,
        overlay: opts.overlay,
      });
    });
  }, []);

  const finishBake = useCallback((out: string | null) => {
    const resolve = bakeResolver.current;
    bakeResolver.current = null;
    setBakeConfig(null);
    resolve?.(out);
  }, []);

  // Rasterise the offscreen composition once its source image has painted.
  const captureBakedView = useCallback(async () => {
    if (!bakeConfig || bakeCaptured.current) return;
    bakeCaptured.current = true;
    let out: string | null = null;
    try {
      // Give the tint/text overlays a frame to paint over the loaded image.
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      const result = await captureRef(bakeViewRef, {
        format: "jpg",
        quality: 0.92,
        result: "tmpfile",
        width: bakeConfig.renderW,
        height: bakeConfig.renderH,
      });
      out = toFileUri(result);
    } catch { out = null; }
    finishBake(out);
  }, [bakeConfig, finishBake]);

  // The source image failed to load, or never reported loading in time.
  // Snapshotting now would bake an empty (black) frame, so give up instead:
  // the caller keeps the original, unbaked photo.
  const abandonBake = useCallback(() => {
    if (bakeCaptured.current) return;
    bakeCaptured.current = true;
    finishBake(null);
  }, [finishBake]);

  useEffect(() => {
    if (!bakeConfig) return;
    const t = setTimeout(abandonBake, 4000);
    return () => clearTimeout(t);
  }, [bakeConfig, abandonBake]);

  // ── Panorama ──────────────────────────────────────────────────────────────
  // A sweep captures a frame every PANO_STEP_DEG of yaw, then composites the
  // frames' centre strips into one wide image (see lib/panorama.ts).

  /** Grab one frame mid-sweep. Re-entrancy-guarded — the sensor can tick again
   *  while takePictureAsync is still in flight. */
  const panoGrabFrame = useCallback(async () => {
    if (!panoActive.current || panoGrabbing.current) return;
    if (panoFrames.current.length >= PANO_MAX_FRAMES) return;
    panoGrabbing.current = true;
    try {
      const photo = await cameraRef.current?.takePictureAsync({
        quality: 0.8,
        skipProcessing: true,
        shutterSound: false,
      });
      // Re-check: the sweep may have been ended while the shot was in flight.
      if (photo?.uri && panoActive.current) {
        panoFrames.current.push({ uri: photo.uri, width: photo.width ?? 0, height: photo.height ?? 0 });
        setPanoFrameCount(panoFrames.current.length);
        if (Platform.OS !== "web") {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        }
      }
    } catch { /* drop this frame and keep sweeping */ }
    finally { panoGrabbing.current = false; }
  }, []);

  /** Fold a yaw reading into the sweep, capturing and finishing at thresholds. */
  const panoOnYaw = useCallback((yawDeg: number) => {
    if (!panoActive.current) return;
    const { total, accepted } = accumulateSweep(panoLastYaw.current, yawDeg, panoSweepRef.current);
    panoLastYaw.current = yawDeg;
    if (!accepted) return;
    panoSweepRef.current = total;
    setPanoSweep(Math.round(total));

    const due = total >= panoNextCaptureAt.current;
    if (due) panoNextCaptureAt.current = total + PANO_STEP_DEG;
    const atEnd = total >= PANO_MAX_SWEEP_DEG || panoFrames.current.length >= PANO_MAX_FRAMES;

    if (due) {
      // Let the last frame land before closing the sweep. finishPano clears
      // panoActive, and panoGrabFrame drops any shot still in flight when it
      // does — so finishing first would silently lose the final strip.
      const grab = panoGrabFrame();
      if (atEnd) grab.then(() => finishPanoRef.current());
      return;
    }
    if (atEnd) finishPanoRef.current();
  }, [panoGrabFrame]);

  const panoStopSensor = useCallback(() => {
    panoSensorSub.current?.remove();
    panoSensorSub.current = null;
    if (panoWebHandler.current && Platform.OS === "web") {
      window.removeEventListener("deviceorientation", panoWebHandler.current);
      panoWebHandler.current = null;
    }
    if (panoTimer.current) { clearInterval(panoTimer.current); panoTimer.current = null; }
  }, []);

  /** Subscribe to a yaw source. Returns false when none is usable, so the
   *  caller can fall back to a timed sweep. */
  const panoStartSensor = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === "web") {
      const DOE: any = (globalThis as any).DeviceOrientationEvent;
      if (!DOE) return false;
      try {
        // iOS Safari gates motion events behind a user-gesture permission call;
        // this runs from the shutter tap, so it is allowed to prompt.
        if (typeof DOE.requestPermission === "function") {
          const res = await DOE.requestPermission();
          if (res !== "granted") return false;
        }
      } catch { return false; }
      let sawReading = false;
      const handler = (e: any) => {
        if (e?.alpha == null) return;
        sawReading = true;
        panoOnYaw(e.alpha);
      };
      panoWebHandler.current = handler;
      window.addEventListener("deviceorientation", handler);
      // Some browsers register the listener happily but never emit; give it a
      // moment and fall back to the timer if nothing arrives.
      await new Promise(r => setTimeout(r, 400));
      if (!sawReading) { panoStopSensor(); return false; }
      return true;
    }

    try {
      const DeviceMotion = await getDeviceMotion();
      if (!DeviceMotion) return false;
      const available = await DeviceMotion.isAvailableAsync().catch(() => false);
      if (!available) return false;
      const perm = await DeviceMotion.requestPermissionsAsync().catch(() => null);
      if (perm && !perm.granted) return false;
      DeviceMotion.setUpdateInterval(60);
      panoSensorSub.current = DeviceMotion.addListener(({ rotation }) => {
        if (rotation?.alpha == null) return;
        panoOnYaw(rotation.alpha * (180 / Math.PI));
      });
      return true;
    } catch { return false; }
  }, [panoOnYaw, panoStopSensor]);

  const finishPanoCompose = useCallback((out: string | null) => {
    const resolve = panoResolver.current;
    panoResolver.current = null;
    setPanoConfig(null);
    resolve?.(out);
  }, []);

  /** Rasterise the offscreen strip row once every frame has painted. */
  const capturePanoView = useCallback(async () => {
    if (!panoConfig || panoCaptured.current) return;
    panoCaptured.current = true;
    let out: string | null = null;
    try {
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      const result = await captureRef(panoViewRef, {
        format: "jpg",
        quality: 0.92,
        result: "tmpfile",
        width: panoConfig.outW,
        height: panoConfig.outH,
      });
      out = toFileUri(result);
    } catch { out = null; }
    finishPanoCompose(out);
  }, [panoConfig, finishPanoCompose]);

  /** A strip failed to load, or the strips didn't all load in time: never
   *  rasterise a composite with black gaps — report failure instead. */
  const abandonPanoCompose = useCallback(() => {
    if (panoCaptured.current) return;
    panoCaptured.current = true;
    finishPanoCompose(null);
  }, [finishPanoCompose]);

  /** Count frames in, and rasterise once they have all loaded. */
  const onPanoFrameLoaded = useCallback(() => {
    panoSettled.current += 1;
    if (panoConfig && panoSettled.current >= panoConfig.frames.length) capturePanoView();
  }, [panoConfig, capturePanoView]);

  // Backstop in case an onLoad never fires. Scales with frame count so a long
  // sweep isn't cut off early.
  useEffect(() => {
    if (!panoConfig) return;
    const t = setTimeout(abandonPanoCompose, 4000 + panoConfig.frames.length * 400);
    return () => clearTimeout(t);
  }, [panoConfig, abandonPanoCompose]);

  const composePano = useCallback((frames: PanoFrame[]): Promise<string | null> => {
    const first = frames[0]!;
    const layout = panoLayout({
      frameW: first.width,
      frameH: first.height,
      frameCount: frames.length,
    });
    panoCaptured.current = false;
    panoSettled.current = 0;
    return new Promise((resolve) => {
      panoResolver.current = resolve;
      setPanoConfig({ ...layout, frames });
    });
  }, []);

  const finishPano = useCallback(async () => {
    if (!panoActive.current) return;
    panoActive.current = false;
    panoStopSensor();
    setIsPanoCapturing(false);

    const frames = [...panoFrames.current];
    panoFrames.current = [];
    setPanoFrameCount(0);
    setPanoSweep(0);
    panoSweepRef.current = 0;
    panoLastYaw.current = null;

    if (frames.length === 0) return;

    let uri = frames[0]!.uri;
    let stitched = false;
    if (frames.length >= PANO_MIN_FRAMES) {
      setPanoComposing(true);
      const composed = await composePano(frames);
      setPanoComposing(false);
      if (composed) {
        uri = composed;
        stitched = true;
      } else {
        // Never silently pass a single frame off as the panorama.
        Alert.alert(
          "Panorama Failed",
          `Could not stitch the ${frames.length} captured frames. Saving the first frame instead.`,
        );
      }
    } else {
      // Below the minimum the composite would be narrower than one ordinary
      // photo, so there is nothing to gain from stitching it.
      showToast("Sweep too short — saved a single frame", 2200);
    }

    // The raw sweep frames are temp files; only the one being kept survives.
    for (const f of frames) if (f.uri !== uri) deleteTempFile(f.uri);

    if (stitched) showToast(`Panorama stitched from ${frames.length} frames`, 2200);
    void doUpload(uri, `PANO_${Date.now()}.jpg`, "image");
  }, [panoStopSensor, composePano, doUpload, showToast]);

  // The sensor callback is created before finishPano exists, so it calls
  // through this ref.
  useEffect(() => { finishPanoRef.current = () => { finishPano(); }; }, [finishPano]);

  const startPano = useCallback(async () => {
    if (panoActive.current) return;
    panoFrames.current = [];
    panoSweepRef.current = 0;
    panoLastYaw.current = null;
    panoNextCaptureAt.current = PANO_STEP_DEG;
    panoActive.current = true;
    setPanoSweep(0);
    setPanoFrameCount(0);
    setIsPanoCapturing(true);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    }

    // Anchor frame straight away so a sweep always has a starting edge.
    await panoGrabFrame();

    const hasSensor = await panoStartSensor();
    if (!hasSensor && panoActive.current) {
      // No usable yaw source (web without motion permission, or a device
      // lacking the sensor): fall back to a timed sweep. The user still pans;
      // we just assume the nominal step per tick instead of measuring it.
      panoTimer.current = setInterval(() => {
        if (!panoActive.current) return;
        panoSweepRef.current += PANO_STEP_DEG;
        setPanoSweep(Math.round(panoSweepRef.current));
        const grab = panoGrabFrame();
        if (panoSweepRef.current >= PANO_MAX_SWEEP_DEG || panoFrames.current.length >= PANO_MAX_FRAMES) {
          grab.then(() => finishPanoRef.current());
        }
      }, PANO_FALLBACK_INTERVAL_MS);
    }
  }, [panoGrabFrame, panoStartSensor]);

  const handlePano = useCallback(() => {
    if (panoComposing) return;
    pulseCaptureBtn();
    if (panoActive.current) finishPano();
    else startPano();
  }, [panoComposing, finishPano, startPano]);

  /**
   * GPS + bearing EXIF for takePictureAsync's `additionalExif`. Keys and value
   * types follow expo-camera 17's native handling: iOS takes signed decimal
   * GPSLatitude/GPSLongitude/GPSAltitude and derives the *Ref tags itself;
   * Android converts the numeric lat/long/altitude via ExifInterface
   * setLatLong/setAltitude, but a rational tag like GPSImgDirection must be a
   * "num/den" string there (a bare decimal is rejected). Empty when EXIF is
   * being stripped or there's nothing to add.
   */
  const buildGpsExif = useCallback((): Record<string, any> | undefined => {
    if (settings.stripExif || Platform.OS === "web") return undefined;
    const exif: Record<string, any> = {};
    const fix = lastFix.current;
    if (settings.saveLocation && fix && Date.now() - fix.timestamp <= MAX_FIX_AGE_MS) {
      exif.GPSLatitude = fix.coords.latitude;
      exif.GPSLongitude = fix.coords.longitude;
      if (fix.coords.altitude != null) exif.GPSAltitude = fix.coords.altitude;
      if (Platform.OS === "ios" && fix.coords.accuracy != null) exif.GPSHPositioningError = fix.coords.accuracy;
      const { date, time } = gpsStamps(fix.timestamp);
      exif.GPSDateStamp = date;
      exif.GPSTimeStamp = time;
    }
    const h = headingRef.current;
    if (settings.compassMeta && h) {
      const deg = Math.round(h.deg * 100) / 100;
      exif.GPSImgDirection = Platform.OS === "android" ? `${Math.round(deg * 100)}/100` : deg;
      exif.GPSImgDirectionRef = h.ref;
    }
    return Object.keys(exif).length > 0 ? exif : undefined;
  }, [settings.stripExif, settings.saveLocation, settings.compassMeta]);

  // Single capture cycle (screen flash → snap → stamp/strip), then a
  // background hand-off to the photo library / upload queue. Resolves as soon
  // as the photo is on disk so the shutter is free for the next shot.
  // The self-timer runs once at the start of a burst, not on every shot.
  const captureOne = useCallback(async (indexLabel?: string) => {
    const flashUp = await screenFlashOn();
    pulseCaptureBtn();
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
    const additionalExif = buildGpsExif();
    let photo: Awaited<ReturnType<CameraView["takePictureAsync"]>> | undefined;
    try {
      photo = await cameraRef.current?.takePictureAsync({
        quality: 0.9,
        // iOS only writes additionalExif (incl. the GPS dictionary) when exif
        // is on; with Strip EXIF on, the file is saved without metadata.
        exif: !settings.stripExif,
        ...(additionalExif ? { additionalExif } : {}),
      });
    } finally {
      // Keep the selfie flash lit until the exposure is done.
      if (flashUp) screenFlashOff();
    }
    if (!photo?.uri) return;
    let uri = photo.uri;

    // Decide what needs baking: the stamp burn-in and/or the selected filter's
    // tint (native can only approximate a filter with a tint overlay — the same
    // one shown in the live preview).
    const wantStamp = settings.stampPhotos;
    const filterOverlay = FILTERS[selectedFilter]?.overlay ?? null;

    // Gather the stamp lines up front so the toast can honestly reflect what was
    // actually burned in (matches the old web stamp: date/time, GPS, bearing).
    const stampLines: string[] = [];
    let stampedLocation = false;
    if (wantStamp) {
      stampLines.push(new Date().toLocaleString());
      const fix = lastFix.current;
      if (settings.saveLocation && fix && Date.now() - fix.timestamp <= MAX_FIX_AGE_MS) {
        stampLines.push(`${fix.coords.latitude.toFixed(5)}, ${fix.coords.longitude.toFixed(5)}`);
        stampedLocation = true;
      }
      if (heading != null) stampLines.push(`Bearing ${heading}°`);
    }

    let baked = false;
    if (wantStamp || filterOverlay) {
      const outUri = await bakeImageNative({
        uri: photo.uri,
        width: photo.width ?? 0,
        height: photo.height ?? 0,
        stampLines,
        overlay: filterOverlay,
      });
      if (outUri) {
        // The raw frame is superseded by the baked copy.
        deleteTempFile(photo.uri);
        uri = outUri;
        baked = true;
      }
    }

    // Only claim the stamp was applied when the bake actually succeeded.
    if (wantStamp) {
      showToast(baked
        ? "Stamped: date · time" + (stampedLocation ? " · location" : "") + (heading != null ? " · bearing" : "")
        : "Stamp failed — saved original");
    }
    // Photos are always JPEG (takePictureAsync and the bake both write JPEG).
    const ext = extensionOf(uri, "jpg");
    const suffix = indexLabel ? `_${indexLabel}` : "";
    const fileName = `IMG_${Date.now()}${suffix}.${ext}`;
    void doUpload(uri, fileName, "image");
  }, [settings.stripExif, settings.stampPhotos, settings.saveLocation, screenFlashOn, screenFlashOff, buildGpsExif, bakeImageNative, selectedFilter, doUpload, heading, showToast]);

  const handlePhotoCapture = useCallback(async () => {
    if (busyRef.current || recordingRef.current) return;
    busyRef.current = true;
    try {
      if (settings.timerSeconds > 0) await runCountdown(settings.timerSeconds);
      const n = Math.max(1, settings.burstCount | 0);
      for (let i = 0; i < n; i++) {
        await captureOne(n > 1 ? String(i + 1).padStart(2, "0") : undefined);
        if (n > 1 && i < n - 1) {
          await new Promise(r => setTimeout(r, Math.max(0, settings.burstDelay) * 1000));
        }
      }
    } catch (err: any) {
      Alert.alert("Capture Failed", err?.message ?? "Could not take photo.");
    } finally { busyRef.current = false; }
  }, [settings.burstCount, settings.burstDelay, settings.timerSeconds, runCountdown, captureOne]);

  // Keep the keyboard-shutter ref pointed at the latest handler
  useEffect(() => { handleCaptureRef.current = () => { handlePhotoCapture(); }; }, [handlePhotoCapture]);

  // iOS only lets you pick the codec; the others record in the platform
  // default. An unsupported codec makes recordAsync reject, so ask first.
  const pickVideoCodec = useCallback(async (): Promise<VideoCodec | undefined> => {
    if (Platform.OS !== "ios") return undefined;
    const wanted = VIDEO_CODEC[settings.videoCodec];
    try {
      const available = await CameraView.getAvailableVideoCodecsAsync();
      return available.includes(wanted) ? wanted : undefined;
    } catch { return undefined; }
  }, [settings.videoCodec]);

  const endRecordingUi = useCallback(() => {
    recordingRef.current = false;
    recordStopping.current = false;
    setIsRecording(false);
    if (recordTimer.current) { clearInterval(recordTimer.current); recordTimer.current = null; }
    setRecordSeconds(0);
  }, []);

  const handleVideoToggle = useCallback(async () => {
    if (recordingRef.current) {
      // Stop — once. A second tap while the recorder winds down is ignored.
      if (recordStopping.current) return;
      recordStopping.current = true;
      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
      try { cameraRef.current?.stopRecording(); } catch { /* already stopped */ }
      return;
    }
    if (busyRef.current) return;
    recordingRef.current = true;
    recordStopping.current = false;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    setIsRecording(true);
    setRecordSeconds(0);
    recordTimer.current = setInterval(() => setRecordSeconds(s => s + 1), 1000);
    const maxDuration = settings.maxVideoDurationSeconds > 0 ? settings.maxVideoDurationSeconds : 600;
    const codec = await pickVideoCodec();
    if (!recordingRef.current || recordStopping.current) { endRecordingUi(); return; }
    const recording = cameraRef.current?.recordAsync({ maxDuration, ...(codec ? { codec } : {}) });
    if (!recording) { endRecordingUi(); return; }
    recording.then((video) => {
      endRecordingUi();
      if (video?.uri) {
        // Name the file after the container the recorder actually wrote
        // (.mov on iOS, .mp4 on Android) — never relabel the bytes.
        const ext = extensionOf(video.uri, Platform.OS === "ios" ? "mov" : "mp4");
        void doUpload(video.uri, `VID_${Date.now()}.${ext}`, "video");
      }
    }).catch((err: any) => {
      endRecordingUi();
      if (!String(err?.message).includes("stop"))
        Alert.alert("Recording Failed", err?.message ?? "Could not record video.");
    });
  }, [settings.maxVideoDurationSeconds, pickVideoCodec, endRecordingUi, doUpload]);

  // Clear every timer and stop any in-flight capture when the camera screen
  // unmounts (e.g. navigating home mid-recording or mid-time-lapse). Without
  // this, a time-lapse setInterval keeps firing takePictureAsync on a torn-down
  // camera forever, and its buffered frames are silently discarded.
  useEffect(() => {
    return () => {
      if (tlTimer.current) clearInterval(tlTimer.current);
      if (recordTimer.current) clearInterval(recordTimer.current);
      if (zoomCollapseTimer.current) clearTimeout(zoomCollapseTimer.current);
      if (programmaticClearTimer.current) clearTimeout(programmaticClearTimer.current);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      // Stop the panorama sweep too — its sensor listener and fallback timer
      // would otherwise keep firing takePictureAsync on a torn-down camera.
      panoActive.current = false;
      panoSensorSub.current?.remove();
      panoSensorSub.current = null;
      if (panoWebHandler.current && Platform.OS === "web") {
        window.removeEventListener("deviceorientation", panoWebHandler.current);
        panoWebHandler.current = null;
      }
      if (panoTimer.current) clearInterval(panoTimer.current);
      // An unfinished sweep can't be stitched any more — drop its temp frames.
      for (const f of panoFrames.current) deleteTempFile(f.uri);
      panoFrames.current = [];
      try { cameraRef.current?.stopRecording(); } catch { /* already stopped */ }
    };
  }, []);

  const handleScan = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    pulseCaptureBtn();
    try {
      // Hand off to the OS document scanner (VisionKit / ML Kit) for live edge
      // detection, corner adjustment, auto-crop, deskew & enhance. It presents
      // its own full-screen capture UI.
      const mod = await getDocumentScanner();
      const DocumentScanner = mod?.default;
      if (!DocumentScanner) throw new Error("Document scanner unavailable on this device.");
      const { scannedImages, status } = await DocumentScanner.scanDocument({
        maxNumDocuments: 1,
        croppedImageQuality: 100,
        responseType: mod!.ResponseType.ImageFilePath,
      });
      if (status === mod!.ScanDocumentResponseStatus.Cancel) return;
      let uri = scannedImages?.[0];
      if (!uri) return;
      // Android can return a bare path; make sure it carries a file scheme.
      if (!/^[a-z]+:\/\//i.test(uri)) uri = `file://${uri}`;
      setScanUri(uri);
      setScanCropped(true);
      setScanFileName(`SCAN_${Date.now()}.${extensionOf(uri, "jpg")}`);
      setShowScanModal(true);
    } catch (err: any) {
      Alert.alert("Scan Failed", err?.message ?? "Could not capture document.");
    } finally { busyRef.current = false; }
  }, []);

  const handleUploadScan = useCallback(() => {
    setShowScanModal(false);
    if (!scanUri || !scanFileName) return;
    void doUpload(scanUri, scanFileName, "image");
    setScanUri(null);
  }, [scanUri, scanFileName, doUpload]);

  // Closing or retaking a scan throws the scanned page away.
  const discardScan = useCallback(() => {
    setShowScanModal(false);
    deleteTempFile(scanUri);
    setScanUri(null);
  }, [scanUri]);

  // INTERVAL (time-lapse) mode: a photo every INTERVAL_SECONDS until stopped,
  // then the series is uploaded as individual photos (no video is made).
  const handleTimelapse = useCallback(async () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    if (!isTimelapsing) {
      setIsTimelapsing(true);
      setTlCount(0);
      tlPhotos.current = [];
      tlTimer.current = setInterval(async () => {
        if (tlGrabbing.current) return; // previous shot still in flight
        tlGrabbing.current = true;
        try {
          const additionalExif = buildGpsExif();
          const photo = await cameraRef.current?.takePictureAsync({
            quality: 0.8,
            exif: !settings.stripExif,
            shutterSound: false,
            ...(additionalExif ? { additionalExif } : {}),
          });
          if (photo?.uri) {
            tlPhotos.current.push(photo.uri);
            setTlCount(c => c + 1);
          }
        } catch { /* skip this shot and keep going */ }
        finally { tlGrabbing.current = false; }
      }, INTERVAL_SECONDS * 1000);
      return;
    }

    if (tlTimer.current) { clearInterval(tlTimer.current); tlTimer.current = null; }
    setIsTimelapsing(false);
    const photos = [...tlPhotos.current];
    tlPhotos.current = [];
    setTlCount(0);
    if (photos.length === 0) return;
    const stamp = Date.now();
    const target = await getUploadTarget();

    if (target.skip) {
      // "Don't upload": the photo library is the only destination.
      let saved = 0;
      for (const uri of photos) {
        if ((await saveToCameraRoll(uri)) === "saved") { saved++; deleteTempFile(uri); }
      }
      showToast(saved > 0
        ? `${saved} interval photo${saved === 1 ? "" : "s"} saved to Photos — cloud upload off`
        : "Cloud upload off — couldn't save to Photos", 2400);
      return;
    }

    const uploadAll = async () => {
      const onDeleteLocal = settings.deleteLocalAfterUpload ? undefined : async () => {};
      for (let i = 0; i < photos.length; i++) {
        const frameUri = photos[i]!;
        if (settings.saveToCameraRoll && Platform.OS !== "web") await saveToCameraRoll(frameUri);
        const name = `INT_${stamp}_${String(i + 1).padStart(3, "0")}.${extensionOf(frameUri, "jpg")}`;
        void executeUpload(frameUri, name, "image", token, target.ids, onDeleteLocal);
      }
    };
    Alert.alert(
      "Interval Photos",
      `Upload the ${photos.length} photo${photos.length === 1 ? "" : "s"} taken every ${INTERVAL_SECONDS} s? They're uploaded as separate photos.`,
      [
        { text: "Discard", style: "destructive", onPress: () => { for (const uri of photos) deleteTempFile(uri); } },
        { text: `Upload ${photos.length}`, onPress: () => { void uploadAll(); } },
      ],
      // Dismissing the dialog (Android back / tap outside) must not lose the series.
      { cancelable: false },
    );
  }, [isTimelapsing, buildGpsExif, settings.stripExif, settings.deleteLocalAfterUpload, settings.saveToCameraRoll, getUploadTarget, executeUpload, token, showToast]);

  // Open the cloud account captures are being uploaded to — its app when
  // installed, otherwise its web UI. See lib/cloudApps.ts for why this attempts
  // openURL rather than asking canOpenURL first.
  const handleOpenCloudApp = useCallback(async () => {
    if (isRecording || isTimelapsing) return;
    const target = resolveUploadTarget(uploadTarget);
    const conn = pickCloudConnection(cloudConnections, target.ids);
    if (!conn) {
      Alert.alert(
        "No Cloud Connected",
        "Connect a cloud account to upload your captures.",
        [
          { text: "Not now", style: "cancel" },
          { text: "Connect", onPress: () => router.push("/settings/add-cloud") },
        ],
      );
      return;
    }

    const { label, appUrl, webUrl } = cloudAppTarget(conn.type, conn.host);
    if (appUrl) {
      try {
        await Linking.openURL(appUrl);
        return;
      } catch { /* app not installed — fall through to the website */ }
    }
    if (webUrl) {
      try {
        await Linking.openURL(webUrl);
        return;
      } catch { /* no browser handler either */ }
    }
    Alert.alert(
      "Can't Open",
      `There's no app or website to open for ${label}. Your uploads are still going there.`,
    );
  }, [isRecording, isTimelapsing, uploadTarget, cloudConnections]);

  const handleCapture = () => {
    const m = extMode;
    if (m === "scan") return handleScan();
    if (m === "pano") return handlePano();
    if (m === "timelapse") return handleTimelapse();
    if (currentModeConfig.isVideo) return handleVideoToggle();
    return handlePhotoCapture();
  };

  const scrollToMode = useCallback((idx: number) => {
    try {
      markProgrammaticScroll();
      modeScrollRef.current?.scrollTo({ x: idx * ITEM_W, animated: true });
    } catch { /* ignore */ }
  }, [markProgrammaticScroll]);

  const cycleFlash = () => {
    const cycle: FlashMode[] = ["auto", "on", "off"];
    setFlash(prev => cycle[(cycle.indexOf(prev) + 1) % 3]!);
  };

  // Ultra-wide is a separate physical lens (iOS only), so it's offered as its
  // own stop ahead of the normalised-zoom stops.
  const ultraWideAvailable = Platform.OS === "ios" && facing === "back" && ultraWideLens != null;
  const onUltraWide = ultraWideAvailable && ultraWideSelected;
  const currentZoomLabel = onUltraWide
    ? (zoom <= 0.02 ? "0.5×" : `UW ${zoomLabel(zoom)}`)
    : zoomLabel(zoom);

  const handleAvailableLenses = useCallback(({ lenses }: { lenses: string[] }) => {
    setUltraWideLens(lenses.find(l => ULTRA_WIDE_LENS_PATTERN.test(l)) ?? null);
  }, []);

  const toggleZoom = useCallback(() => {
    if (zoomCollapseTimer.current) clearTimeout(zoomCollapseTimer.current);
    setZoomExpanded(prev => {
      if (!prev) {
        zoomCollapseTimer.current = setTimeout(() => setZoomExpanded(false), 3000);
      }
      return !prev;
    });
  }, []);

  const selectZoom = useCallback((value: number, ultraWide = false) => {
    setUltraWideSelected(ultraWide);
    setZoom(value);
    baseZoom.current = value;
    if (zoomCollapseTimer.current) clearTimeout(zoomCollapseTimer.current);
    zoomCollapseTimer.current = setTimeout(() => setZoomExpanded(false), 2000);
  }, []);

  const flashIcon = flash === "on" ? "flash" : flash === "off" ? "flash-off" : "flash-outline";
  const formatTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  // Auto-hide the "Uploaded" success badge after the configured duration.
  // Only the successful ("done") state is dismissed on a timer — failed/partial
  // and in-progress states stay visible until the next upload.
  const [doneBadgeHidden, setDoneBadgeHidden] = useState(false);
  useEffect(() => {
    if (lastUpload?.status === "done" && settings.uploadedBadgeSeconds > 0) {
      setDoneBadgeHidden(false);
      const t = setTimeout(() => setDoneBadgeHidden(true), settings.uploadedBadgeSeconds * 1000);
      return () => clearTimeout(t);
    }
    setDoneBadgeHidden(false);
  }, [lastUpload?.id, lastUpload?.status, settings.uploadedBadgeSeconds]);

  const uploadStatusColor = !lastUpload ? "transparent"
    : lastUpload.status === "done" ? "#22c55e"
    : lastUpload.status === "failed" ? "#ef4444"
    : lastUpload.status === "partial" ? "#f59e0b"
    : lastUpload.status === "uploading" ? PRIMARY : "#6b7280";

  const uploadStatusIcon = !lastUpload ? "cloud-outline"
    : lastUpload.status === "done" ? "cloud-done-outline"
    : lastUpload.status === "failed" ? "cloud-offline-outline"
    : lastUpload.status === "partial" ? "cloud-outline" : "cloud-upload-outline";

  const uploadStatusLabel = !lastUpload ? ""
    : lastUpload.status === "done" ? "Uploaded"
    : lastUpload.status === "failed" ? "Failed"
    : lastUpload.status === "partial" ? "Partial"
    : lastUpload.status === "uploading" ? "Uploading…"
    : lastUpload.status === "queued" ? "Queued" : "";

  const activeFilter = FILTERS[selectedFilter];
  const filterOverlay = Platform.OS !== "web" ? (activeFilter?.overlay ?? null) : null;
  const filterCssWeb = Platform.OS === "web" ? (activeFilter?.css ?? null) : null;

  if (!cameraPermission) return <View style={styles.container} />;

  if (!cameraPermission.granted) {
    return (
      <View style={[styles.container, styles.centeredContainer]}>
        <Ionicons name="camera-outline" size={56} color={PRIMARY} />
        <Text style={styles.permText}>Camera access is needed to take photos and videos.</Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestCameraPermission}>
          <Text style={styles.permBtnText}>Grant Camera Access</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.permSkip} onPress={() => router.push("/settings")}>
          <Text style={styles.permSkipText}>Go to Settings instead</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!hasAccess) {
    return (
      <View style={[styles.container, styles.centeredContainer]}>
        <StatusBar barStyle="light-content" />
        <Ionicons name="lock-closed" size={52} color={PRIMARY} style={{ marginBottom: 20 }} />
        <Text style={styles.paywallTitle}>Subscription Required</Text>
        <Text style={styles.paywallBody}>Your free trial has ended.{"\n"}Subscribe to keep using KKamera.</Text>
        <TouchableOpacity style={styles.paywallBtn} onPress={() => router.push("/settings/subscription")}>
          <Ionicons name="card-outline" size={18} color="white" />
          <Text style={styles.paywallBtnText}>View Subscription — $30/year</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isVideoMode = currentModeConfig.isVideo && extMode !== "timelapse";
  const captureIsActive = isRecording || isTimelapsing || isPanoCapturing || panoComposing;

  const handleModeScrollEnd = (e: any) => {
    if (programmaticScroll.current) return; // ignore scrolls we triggered ourselves
    const x = e?.nativeEvent?.contentOffset?.x ?? 0;
    const idx = Math.round(x / ITEM_W);
    const clamped = Math.max(0, Math.min(idx, STRIP_MODES.length - 1));
    if (!captureIsActive) setExtMode(STRIP_MODES[clamped]!.mode);
  };

  return (
    <GestureDetector gesture={pinchGesture}>
      <View style={styles.container}>
        <StatusBar barStyle="light-content" />
        {trialDaysLeft !== null && <TrialBanner daysLeft={trialDaysLeft} />}

        <CameraView
          ref={cameraRef}
          style={[
            StyleSheet.absoluteFill,
            settings.flipPreview ? { transform: [{ rotate: "180deg" }] } : null,
            // Web: real GPU colour-grade on the live preview.
            filterCssWeb ? ({ filter: filterCssWeb } as any) : null,
          ]}
          facing={facing}
          flash={flash}
          zoom={zoom}
          mode={cameraViewMode}
          mirror={facing === "front" && settings.mirrorFrontCamera}
          videoQuality={VIDEO_QUALITY[settings.videoQuality] ?? "1080p"}
          // iOS: shoot landscape photos/videos when the phone is turned, even
          // though the app UI is locked to portrait.
          responsiveOrientationWhenOrientationLocked
          selectedLens={onUltraWide ? ultraWideLens! : undefined}
          onAvailableLensesChanged={handleAvailableLenses}
        >
          {/* Native preview approximation (web uses the CSS grade above) */}
          {filterOverlay && (
            <View
              style={[StyleSheet.absoluteFill, {
                backgroundColor: filterOverlay.color,
                opacity: filterOverlay.opacity,
              }]}
              pointerEvents="none"
            />
          )}

          {/* Level guide */}
          {settings.showLevelGuide && (
            <View style={[StyleSheet.absoluteFill, styles.levelContainer]} pointerEvents="none">
              {/* Fixed reference line — goes green too when level */}
              <View style={[
                styles.levelRefLine,
                Math.abs(levelRoll) <= LEVEL_TOLERANCE_DEG && styles.levelRefLineActive,
              ]} />
              {/* Tilt line — rotates with the device, snaps green when level */}
              <View style={[
                styles.levelLine,
                { transform: [{ rotate: `${-levelRoll}deg` }] },
                Math.abs(levelRoll) <= LEVEL_TOLERANCE_DEG && styles.levelLineActive,
              ]} />
              <View style={[
                styles.levelDot,
                Math.abs(levelRoll) <= LEVEL_TOLERANCE_DEG && styles.levelDotActive,
              ]} />
            </View>
          )}

          {/* Composition grid overlay */}
          {settings.gridType !== "off" && (
            <GridOverlay type={settings.gridType} />
          )}

          {/* Compass bearing badge */}
          {heading != null && (
            <View style={styles.compassBadge} pointerEvents="none">
              <Ionicons name="compass-outline" size={13} color={PRIMARY} />
              <Text style={styles.compassText}>{heading}°</Text>
            </View>
          )}

          {/* Scan overlay */}
          {extMode === "scan" && (
            <View style={[StyleSheet.absoluteFill, styles.overlayCenter]} pointerEvents="none">
              <View style={styles.scanFrame}>
                <View style={[styles.scanCorner, styles.scanTL]} />
                <View style={[styles.scanCorner, styles.scanTR]} />
                <View style={[styles.scanCorner, styles.scanBL]} />
                <View style={[styles.scanCorner, styles.scanBR]} />
              </View>
              <Text style={styles.scanHint}>Align document within frame</Text>
            </View>
          )}

          {/* Pano guide + live sweep progress */}
          {extMode === "pano" && (
            <View style={[StyleSheet.absoluteFill, styles.overlayCenter]} pointerEvents="none">
              <View style={styles.panoLine} />
              {isPanoCapturing ? (
                <>
                  <View style={styles.panoTrack}>
                    <View
                      style={[
                        styles.panoFill,
                        { width: `${Math.min(100, (panoSweep / PANO_MAX_SWEEP_DEG) * 100)}%` },
                      ]}
                    />
                  </View>
                  <Text style={styles.panoProgress}>
                    {panoSweep}° · {panoFrameCount} frame{panoFrameCount === 1 ? "" : "s"}
                  </Text>
                  <Text style={styles.modeHint}>
                    Keep panning — tap the shutter to finish
                  </Text>
                </>
              ) : panoComposing ? (
                <Text style={styles.panoProgress}>Stitching panorama…</Text>
              ) : (
                <Text style={styles.modeHint}>
                  Tap the shutter, then pan slowly left to right
                </Text>
              )}
            </View>
          )}

          {/* Time-lapse counter */}
          {isTimelapsing && (
            <View style={[styles.tlCounter]} pointerEvents="none">
              <Ionicons name="timer-outline" size={16} color={PRIMARY} />
              <Text style={styles.tlCountText}>{tlCount} photo{tlCount === 1 ? "" : "s"} · every {INTERVAL_SECONDS} s</Text>
            </View>
          )}
        </CameraView>

        {/* ── Top Bar ─────────────────────────────────────────────────────── */}
        <View style={[styles.topBar, { paddingTop: insets.top + (Platform.OS === "web" ? 20 : 4) }]}>
          <TouchableOpacity style={styles.iconBtn} onPress={cycleFlash}>
            <Ionicons name={flashIcon as any} size={21} color={flash === "on" ? "#FFD700" : "white"} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={toggleLevelGuide}>
            <MaterialCommunityIcons name="spirit-level" size={19} color={settings.showLevelGuide ? PRIMARY : "white"} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => {
            const next = settings.gridType === "off" ? "thirds" : settings.gridType === "thirds" ? "golden" : settings.gridType === "golden" ? "square" : settings.gridType === "square" ? "diagonal" : "off";
            updateSetting("gridType", next);
          }}>
            <Ionicons name="grid-outline" size={18} color={settings.gridType !== "off" ? PRIMARY : "white"} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => {
            const next = settings.timerSeconds === 0 ? 3 : settings.timerSeconds === 3 ? 10 : 0;
            updateSetting("timerSeconds", next);
          }}>
            <Ionicons name="timer-outline" size={19} color={settings.timerSeconds > 0 ? PRIMARY : "white"} />
            {settings.timerSeconds > 0 && (
              <Text style={styles.timerBadge}>{settings.timerSeconds}s</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setShowFilters(v => !v)}>
            <Feather name="sliders" size={18} color={showFilters ? PRIMARY : "white"} />
          </TouchableOpacity>
          {(isRecording) && (
            <View style={styles.recordingBadge}>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingTime}>{formatTime(recordSeconds)}</Text>
            </View>
          )}
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.push("/settings")}>
            <Ionicons name="settings-outline" size={21} color="white" />
          </TouchableOpacity>
        </View>

        {/* ── Upload status badge ─────────────────────────────────────────── */}
        {lastUpload && uploadStatusLabel !== "" && settings.recordHistory && !(lastUpload.status === "done" && doneBadgeHidden) && (
          <TouchableOpacity
            style={[styles.uploadStatus, { top: insets.top + (Platform.OS === "web" ? 110 : 70) }]}
            onPress={() => router.push("/history")}
          >
            <Ionicons name={uploadStatusIcon as any} size={16} color={uploadStatusColor} />
            <Text style={[styles.uploadStatusText, { color: uploadStatusColor }]}>{uploadStatusLabel}</Text>
          </TouchableOpacity>
        )}

        {/* ── Filter panel ────────────────────────────────────────────────── */}
        {showFilters && (
          <View style={[styles.filterPanel, { top: insets.top + (Platform.OS === "web" ? 100 : 60) }]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScroll}>
              {FILTERS.map((f, i) => (
                <TouchableOpacity key={f.name} style={styles.filterChip} onPress={() => setSelectedFilter(i)}>
                  <View style={[styles.filterThumb, {
                    backgroundColor: f.swatch,
                    borderWidth: selectedFilter === i ? 2 : 0,
                    borderColor: PRIMARY,
                  }]}>
                    {f.isBeauty && <Text style={styles.filterBeautyIcon}>✨</Text>}
                  </View>
                  <Text style={[styles.filterLabel, selectedFilter === i && { color: PRIMARY }]}>{f.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* ── Collapsible Zoom (right side) ───────────────────────────────── */}
        <View style={[styles.zoomSideBar, { top: "35%" }]}>
          {zoomExpanded && ultraWideAvailable && (
            <TouchableOpacity style={styles.zoomSideBtn} onPress={() => selectZoom(0, true)}>
              <Text style={[styles.zoomSideLabel, onUltraWide && zoom <= 0.02 && styles.zoomSideLabelActive]}>
                0.5×
              </Text>
            </TouchableOpacity>
          )}
          {zoomExpanded && ZOOM_LEVELS.map(({ value, label }) => (
            <TouchableOpacity key={value} style={styles.zoomSideBtn} onPress={() => selectZoom(value)}>
              <Text style={[styles.zoomSideLabel, !onUltraWide && Math.abs(zoom - value) < 0.03 && styles.zoomSideLabelActive]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={[styles.zoomSideBtn, styles.zoomBadgeBtn]} onPress={toggleZoom}>
            <Text style={styles.zoomBadgeText}>{currentZoomLabel}</Text>
          </TouchableOpacity>
        </View>

        {/* ── Bottom Controls ─────────────────────────────────────────────── */}
        <View style={[styles.bottomControls, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 20 : 8) }]}>

          {/* ── iOS-style liquid glass mode strip ──────────────────────── */}
          <View style={styles.modeStripWrapper}>
            {/* Frosted glass background */}
            <View
              style={[styles.modeGlassBg, Platform.OS === "web" && ({
                backdropFilter: "blur(24px)",
                WebkitBackdropFilter: "blur(24px)",
              } as any)]}
            />
            {/* Fixed center highlight pill */}
            <View style={[styles.modeCenterPill, { left: (screenW - ITEM_W + 10) / 2, width: ITEM_W - 10 }]} pointerEvents="none" />
            {/* Scrollable mode labels */}
            <ScrollView
              ref={modeScrollRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              snapToInterval={ITEM_W}
              decelerationRate="fast"
              snapToAlignment="start"
              onMomentumScrollEnd={handleModeScrollEnd}
              onScrollEndDrag={Platform.OS === "web" ? handleModeScrollEnd : undefined}
              contentContainerStyle={{ paddingHorizontal: (screenW - ITEM_W) / 2 }}
              style={{ flex: 1 }}
              contentOffset={stripContentOffset}
            >
              {STRIP_MODES.map((m, i) => {
                const isActive = m.mode === extMode;
                const lbl = STRIP_LABEL[m.mode] ?? m.label;
                return (
                  <TouchableOpacity
                    key={m.mode}
                    style={{ width: ITEM_W, alignItems: "center", justifyContent: "center", paddingVertical: 10 }}
                    onPress={() => { if (!captureIsActive) { setExtMode(m.mode); scrollToMode(i); } }}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[styles.stripLabel, isActive && styles.stripLabelActive]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.8}
                    >{lbl}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {/* Capture row */}
          <View style={styles.captureRow}>
            {/* Gallery import */}
            <TouchableOpacity
              style={styles.sideBtn}
              onPress={handleOpenCloudApp}
              disabled={captureIsActive}
              accessibilityRole="button"
              accessibilityLabel="Open your cloud storage"
            >
              <Ionicons name="cloud-outline" size={26} color={captureIsActive ? "#333" : "white"} />
            </TouchableOpacity>

            {/* Capture button */}
            <Animated.View style={{ transform: [{ scale: captureScale }] }}>
              <TouchableOpacity
                style={[
                  styles.captureBtn,
                  isVideoMode && { borderColor: "#ef4444" },
                  extMode === "scan" && { borderColor: PRIMARY },
                  extMode === "timelapse" && { borderColor: "#f59e0b" },
                  extMode === "pano" && { borderColor: PRIMARY },
                ]}
                onPress={handleCapture}
                activeOpacity={0.8}
                disabled={panoComposing}
              >
                {extMode === "pano" ? (
                  <View style={[
                    styles.captureInner,
                    isPanoCapturing
                      ? { backgroundColor: PRIMARY, borderRadius: 6, width: 28, height: 28 }
                      : { backgroundColor: PRIMARY, opacity: panoComposing ? 0.4 : 1 },
                  ]} />
                ) : extMode === "timelapse" ? (
                  <View style={[
                    styles.captureInner,
                    isTimelapsing
                      ? { backgroundColor: "#f59e0b", borderRadius: 6, width: 28, height: 28 }
                      : { backgroundColor: "#f59e0b" },
                  ]} />
                ) : isVideoMode ? (
                  <View style={[
                    styles.captureInner,
                    isRecording
                      ? { backgroundColor: "#ef4444", borderRadius: 6, width: 28, height: 28 }
                      : { backgroundColor: "white" },
                  ]} />
                ) : extMode === "scan" ? (
                  <Ionicons name="document-text" size={26} color={PRIMARY} />
                ) : (
                  <View style={styles.captureInner} />
                )}
              </TouchableOpacity>
            </Animated.View>

            {/* Flip camera */}
            <TouchableOpacity
              style={styles.sideBtn}
              onPress={() => {
                const next = facing === "back" ? "front" : "back";
                // Front camera has no useful zoom range; rear resumes at the default.
                const z = next === "front" ? FRONT_CAMERA_ZOOM : settings.defaultZoom;
                setUltraWideSelected(false);
                setFacing(next);
                setZoom(z);
                baseZoom.current = z;
              }}
              disabled={captureIsActive}
            >
              <Ionicons name="camera-reverse-outline" size={26} color={captureIsActive ? "#333" : "white"} />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Countdown overlay ───────────────────────────────────────────── */}
        {countdown != null && (
          <View style={styles.countdownOverlay} pointerEvents="none">
            <Text style={styles.countdownText}>{countdown}</Text>
          </View>
        )}

        {/* ── Screen flash (selfie) ───────────────────────────────────────── */}
        {screenFlashing && (
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: "white", opacity: screenFlashOpacity }]}
          />
        )}

        {/* ── Stamp toast ─────────────────────────────────────────────────── */}
        {stampToast && (
          <View style={[styles.stampToast, { bottom: insets.bottom + 180 }]} pointerEvents="none">
            <Ionicons name="pricetag-outline" size={13} color={PRIMARY} />
            <Text style={styles.stampToastText}>{stampToast}</Text>
          </View>
        )}

        {isProcessingScan && (
          <View style={[styles.stampToast, { bottom: insets.bottom + 180 }]} pointerEvents="none">
            <Ionicons name="scan-outline" size={13} color={PRIMARY} />
            <Text style={styles.stampToastText}>Processing document…</Text>
          </View>
        )}

        {/* ── Scan result modal ───────────────────────────────────────────── */}
        <Modal visible={showScanModal} animationType="slide" onRequestClose={discardScan}>
          <View style={styles.scanModal}>
            <View style={styles.scanModalHeader}>
              <TouchableOpacity onPress={discardScan} style={styles.scanModalClose}>
                <Ionicons name="close" size={24} color="white" />
              </TouchableOpacity>
              <Text style={styles.scanModalTitle}>Document Scan</Text>
              <View style={{ width: 40 }} />
            </View>
            {Platform.OS === "web" && (
              <View style={styles.scanBadgeRow}>
                <Ionicons name={scanCropped ? "scan-outline" : "color-wand-outline"} size={13} color={PRIMARY} />
                <Text style={styles.scanBadgeText}>
                  {scanCropped ? "Auto-cropped · Flattened · Enhanced" : "Enhanced (edges not detected — full frame kept)"}
                </Text>
              </View>
            )}
            {scanUri && (
              <Image source={{ uri: scanUri }} style={styles.scanPreview} resizeMode="contain" accessibilityLabel="Document scan preview" />
            )}
            <View style={styles.scanModalFooter}>
              <TouchableOpacity style={styles.scanRetakeBtn} onPress={discardScan}>
                <Ionicons name="camera-outline" size={18} color={PRIMARY} />
                <Text style={styles.scanRetakeText}>Retake</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.scanUploadBtn} onPress={handleUploadScan}>
                <Ionicons name="cloud-upload-outline" size={18} color="white" />
                <Text style={styles.scanUploadText}>Upload Scan</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* ── Offscreen bake composition (react-native-view-shot target) ───── */}
        {bakeConfig && (
          <View
            ref={bakeViewRef}
            collapsable={false}
            pointerEvents="none"
            style={{ position: "absolute", left: -100000, top: 0, width: bakeConfig.renderW, height: bakeConfig.renderH }}
          >
            <Image
              source={{ uri: bakeConfig.uri }}
              style={{ width: bakeConfig.renderW, height: bakeConfig.renderH }}
              resizeMode="cover"
              onLoad={captureBakedView}
              onError={abandonBake}
              fadeDuration={0}
            />
            {bakeConfig.overlay && (
              <View
                style={[StyleSheet.absoluteFill, {
                  backgroundColor: bakeConfig.overlay.color,
                  opacity: bakeConfig.overlay.opacity,
                }]}
              />
            )}
            {bakeConfig.stampLines.length > 0 && (
              <View style={{ position: "absolute", left: bakeConfig.pad, bottom: bakeConfig.pad }}>
                {bakeConfig.stampLines.map((ln, i) => (
                  <Text
                    key={i}
                    style={{
                      color: PRIMARY,
                      fontSize: bakeConfig.fs,
                      fontFamily: "Inter_600SemiBold",
                      lineHeight: Math.round(bakeConfig.fs * 1.25),
                      textShadowColor: "rgba(0,0,0,0.85)",
                      textShadowRadius: 6,
                    }}
                  >{ln}</Text>
                ))}
              </View>
            )}
          </View>
        )}

        {/* ── Offscreen panorama composition (strip row → one wide JPEG) ───── */}
        {panoConfig && (
          <View
            ref={panoViewRef}
            collapsable={false}
            pointerEvents="none"
            style={{
              position: "absolute", left: -100000, top: 0,
              width: panoConfig.outW, height: panoConfig.outH,
              flexDirection: "row", backgroundColor: "#000",
            }}
          >
            {panoConfig.frames.map((f, i) => (
              // Each frame contributes a centre strip: the image is rendered at
              // full width inside a narrower clipping view and shifted left so
              // its middle lands in the slice.
              <View
                key={`${f.uri}-${i}`}
                style={{ width: panoConfig.sliceW, height: panoConfig.outH, overflow: "hidden" }}
              >
                <Image
                  source={{ uri: f.uri }}
                  style={{
                    width: panoConfig.frameW,
                    height: panoConfig.frameH,
                    marginLeft: panoConfig.frameOffsetX,
                  }}
                  resizeMode="cover"
                  fadeDuration={0}
                  onLoad={onPanoFrameLoaded}
                  onError={abandonPanoCompose}
                />
              </View>
            ))}
          </View>
        )}

      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  centeredContainer: { alignItems: "center", justifyContent: "center", padding: 32 },
  topBar: {
    position: "absolute", top: 0, left: 0, right: 0,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 14, paddingBottom: 6,
    backgroundColor: "rgba(0,0,0,0.32)",
  },
  iconBtn: { padding: 5, borderRadius: 18 },
  recordingBadge: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
  },
  recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#ef4444" },
  recordingTime: { color: "white", fontSize: 13, fontFamily: "Inter_500Medium" },
  uploadStatus: {
    position: "absolute", right: 14,
    flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: "rgba(0,0,0,0.65)", paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 14, borderWidth: 1, borderColor: "rgba(177,152,112,0.3)",
  },
  uploadStatusText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  overlayCenter: { alignItems: "center", justifyContent: "center" },
  levelContainer: { alignItems: "center", justifyContent: "center" },
  levelRefLine: { width: "30%", height: 1, backgroundColor: "rgba(255,255,255,0.25)", position: "absolute" },
  levelRefLineActive: { backgroundColor: "rgba(34,197,94,0.6)" },
  levelLine: { width: "60%", height: 2, backgroundColor: "rgba(177,152,112,0.85)", position: "absolute" },
  levelLineActive: { backgroundColor: "#22c55e" },
  levelDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: PRIMARY },
  levelDotActive: { backgroundColor: "#22c55e" },
  compassBadge: {
    position: "absolute", top: 12, alignSelf: "center",
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 9, paddingVertical: 3, borderRadius: 11,
    backgroundColor: "rgba(0,0,0,0.55)", borderWidth: 1, borderColor: "rgba(177,152,112,0.35)",
  },
  compassText: { color: PRIMARY, fontSize: 11, fontFamily: "Inter_600SemiBold" },
  timerBadge: {
    position: "absolute", top: 1, right: -2,
    color: PRIMARY, fontSize: 9, fontFamily: "Inter_700Bold",
    backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 3, borderRadius: 6,
  },
  countdownOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  countdownText: {
    color: "white", fontSize: 140, fontFamily: "Inter_700Bold",
    textShadowColor: "rgba(0,0,0,0.6)", textShadowRadius: 18,
  },
  stampToast: {
    position: "absolute", alignSelf: "center",
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16,
    backgroundColor: "rgba(0,0,0,0.78)", borderWidth: 1, borderColor: "rgba(177,152,112,0.4)",
  },
  stampToastText: { color: PRIMARY, fontSize: 12, fontFamily: "Inter_500Medium" },
  scanFrame: { width: "76%", aspectRatio: 0.77, position: "relative" },
  scanCorner: { position: "absolute", width: 28, height: 28, borderColor: PRIMARY, borderWidth: 3 },
  scanTL: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 6 },
  scanTR: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 6 },
  scanBL: { bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 6 },
  scanBR: { bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 6 },
  scanHint: { color: "rgba(177,152,112,0.9)", fontSize: 12, fontFamily: "Inter_500Medium", marginTop: 16, textAlign: "center" },
  panoLine: { width: "80%", height: 1, backgroundColor: "rgba(177,152,112,0.8)" },
  panoTrack: {
    width: "70%", height: 4, borderRadius: 2, marginTop: 18,
    backgroundColor: "rgba(255,255,255,0.18)", overflow: "hidden",
  },
  panoFill: { height: "100%", backgroundColor: PRIMARY, borderRadius: 2 },
  panoProgress: {
    marginTop: 10, fontSize: 15, color: PRIMARY, fontFamily: "Inter_600SemiBold",
    textShadowColor: "rgba(0,0,0,0.8)", textShadowRadius: 6,
  },
  modeHint: { color: "rgba(177,152,112,0.9)", fontSize: 12, fontFamily: "Inter_500Medium", marginTop: 12 },
  tlCounter: {
    position: "absolute", top: "40%", alignSelf: "center",
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20,
    borderWidth: 1, borderColor: PRIMARY,
  },
  tlCountText: { color: PRIMARY, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  filterPanel: {
    position: "absolute", left: 0, right: 0,
    backgroundColor: "rgba(0,0,0,0.72)",
  },
  filterScroll: { paddingHorizontal: 16, paddingVertical: 10, gap: 14 },
  filterChip: { alignItems: "center", gap: 4 },
  filterThumb: { width: 46, height: 46, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  filterBeautyIcon: { fontSize: 18 },
  filterLabel: { color: "rgba(255,255,255,0.65)", fontSize: 10, fontFamily: "Inter_400Regular" },
  zoomSideBar: {
    position: "absolute", right: 14,
    backgroundColor: "rgba(18,14,10,0.28)",
    borderRadius: 22, paddingVertical: 4, paddingHorizontal: 2,
    borderWidth: 1, borderColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
  },
  zoomSideBtn: { paddingVertical: 8, paddingHorizontal: 10 },
  zoomSideLabel: { color: "rgba(255,255,255,0.45)", fontSize: 12, fontFamily: "Inter_600SemiBold" },
  zoomSideLabelActive: { color: PRIMARY, fontSize: 13 },
  zoomBadgeBtn: { borderTopWidth: 0 },
  zoomBadgeText: { color: PRIMARY, fontSize: 13, fontFamily: "Inter_600SemiBold" },
  bottomControls: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    backgroundColor: "rgba(0,0,0,0.78)",
  },
  modeStripWrapper: {
    height: 48,
    overflow: "hidden",
    position: "relative",
  },
  modeGlassBg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(14,11,8,0.62)",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.12)",
  },
  modeCenterPill: {
    position: "absolute",
    top: 6,
    bottom: 6,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.14)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.28)",
    zIndex: 0,
    // subtle top specular highlight (approximates liquid glass)
    shadowColor: "white",
    shadowOffset: { width: 0, height: -1 },
    shadowOpacity: 0.18,
    shadowRadius: 1,
  },
  stripLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.4)",
    letterSpacing: 1.1,
    // Keep the label inside the center pill (width ITEM_W - 10) so long labels
    // like "TIME-LAPSE" never spill past the oval.
    maxWidth: ITEM_W - 16,
    textAlign: "center",
  },
  stripLabelActive: {
    color: "white",
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
  },
  captureRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 48, paddingTop: 14, paddingBottom: 10,
  },
  sideBtn: { width: 50, height: 50, alignItems: "center", justifyContent: "center" },
  captureBtn: {
    width: 76, height: 76, borderRadius: 38,
    borderWidth: 4, borderColor: "white",
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  captureInner: { width: 54, height: 54, borderRadius: 27, backgroundColor: "white" },
  permText: {
    fontSize: 16, color: "white", fontFamily: "Inter_400Regular",
    textAlign: "center", paddingHorizontal: 32, marginVertical: 20,
  },
  permBtn: { backgroundColor: PRIMARY, paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14, marginBottom: 12 },
  permBtnText: { color: "white", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  permSkip: { paddingVertical: 8 },
  permSkipText: { color: "#888", fontSize: 13, fontFamily: "Inter_400Regular" },
  paywallTitle: { fontSize: 26, fontFamily: "Inter_700Bold", color: "white", marginBottom: 12, textAlign: "center" },
  paywallBody: { fontSize: 15, color: "#aaa", fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 22, marginBottom: 32 },
  paywallBtn: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: PRIMARY, paddingHorizontal: 28, paddingVertical: 16, borderRadius: 16,
  },
  paywallBtnText: { color: "white", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  scanModal: { flex: 1, backgroundColor: "#0d0b08" },
  scanModalHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    padding: 16, paddingTop: 56, borderBottomWidth: 1, borderBottomColor: "rgba(177,152,112,0.2)",
  },
  scanModalClose: { padding: 8 },
  scanModalTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
  scanBadgeRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5,
    paddingVertical: 6,
  },
  scanBadgeText: { color: PRIMARY, fontSize: 12, fontFamily: "Inter_500Medium" },
  scanPreview: { flex: 1, width: "100%" },
  scanModalFooter: {
    flexDirection: "row", gap: 12, padding: 20, paddingBottom: 40,
    borderTopWidth: 1, borderTopColor: "rgba(177,152,112,0.2)",
  },
  scanRetakeBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    borderWidth: 1, borderColor: PRIMARY, borderRadius: 14, paddingVertical: 14,
  },
  scanRetakeText: { color: PRIMARY, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  scanUploadBtn: {
    flex: 2, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 14,
  },
  scanUploadText: { color: "white", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
