import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
  Animated, Easing, StatusBar, Alert, ScrollView, Modal, Image,
  useWindowDimensions, Linking, AppState,
} from "react-native";
import * as Speech from "expo-speech";
import * as Location from "expo-location";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons, Feather } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
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
import { resolveUploadTarget } from "@/lib/uploadTarget";
import { MAX_RECORDING_BYTES } from "@/lib/config";
import { useUploadTargetResolver } from "@/lib/useUploadTargetResolver";
import {
  readCachedSubscription, writeCachedSubscription, subscriptionAllows, type SubscriptionSnapshot,
} from "@/lib/offlineCache";
import {
  saveToCameraRoll, deleteTempFile, extensionOf, viewShotSize, notifyWitness as sendWitnessNotice,
} from "@/lib/captureStorage";
import {
  accumulateSweep, directionFromPosition, panoLayout, type PanoLayout, type PanoDirection,
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

// Lazy import so expo-sensors is never loaded on web (import-time crash).
// DeviceMotion drives both the level guide (gravity) and the panorama sweep
// (gyro rate projected onto gravity, falling back to rotation.alpha).
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

/**
 * Spirit-level reading from an "up" vector in screen coordinates (x → right
 * edge, y → top edge; any unit). `roll` is how far the device is rotated
 * counter-clockwise from upright (degrees, -180..180). `base` snaps that to the
 * nearest held orientation — 0 portrait, ±90 landscape, 180 upside-down — and
 * `deviation` is the tilt away from it, which is what "level" is judged on.
 * Returns null when the phone is lying flat (gravity is ~perpendicular to the
 * screen), where a horizon angle is meaningless.
 */
function levelFromUp(ux: number, uy: number, uz: number) {
  const planar = Math.hypot(ux, uy);
  if (planar < 0.35 * Math.hypot(ux, uy, uz)) return null;
  const roll = Math.atan2(ux, uy) * (180 / Math.PI);
  let base = Math.round(roll / 90) * 90;
  if (base === -180) base = 180;
  let deviation = roll - base;
  if (deviation > 180) deviation -= 360;
  if (deviation < -180) deviation += 360;
  return { roll, base, deviation };
}

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


// iOS Camera-style ordered strip: PANO · VIDEO · PHOTO · DOC · INTERVAL.
// DOC hands off to the OS document scanner (VisionKit / ML Kit), which only
// exists on native — it is not offered on web.
const STRIP_MODES: ModeConfig[] = [
  EXT_MODES.find(m => m.mode === "pano")!,
  EXT_MODES.find(m => m.mode === "video")!,
  EXT_MODES.find(m => m.mode === "photo")!,
  ...(Platform.OS === "web" ? [] : [EXT_MODES.find(m => m.mode === "scan")!]),
  EXT_MODES.find(m => m.mode === "timelapse")!,
];
const STRIP_LABEL: Partial<Record<ExtMode, string>> = {
  scan: "DOC", timelapse: "INTERVAL",
};
// Spoken names for the mode strip (the visual labels are all-caps shorthand).
const MODE_A11Y_LABEL: Record<ExtMode, string> = {
  photo: "Photo", video: "Video", timelapse: "Interval", pano: "Panorama", scan: "Document scan",
};
const GRID_LABEL: Record<string, string> = {
  off: "off", thirds: "rule of thirds", golden: "golden ratio", square: "square", diagonal: "diagonal",
};
// Top-bar icons are ~30pt; these bring their touch targets to ~44pt+.
const ICON_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };
const ZOOM_HIT_SLOP = { top: 4, bottom: 4, left: 10, right: 10 };
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
  /** dp per output pixel — renderW/pad/fs are in px (see viewShotSize). */
  dp: number;
  capture: { width: number; height: number };
}

interface PanoFrame { uri: string; width: number; height: number; angle: number }

// Offscreen strip composition for PANO, rasterised the same way as BakeConfig.
interface PanoConfig extends PanoLayout {
  frames: PanoFrame[];
  /** dp per output pixel (see viewShotSize). */
  dp: number;
  capture: { width: number; height: number };
}

type ExecuteUpload = ReturnType<typeof useUpload>["executeUpload"];

// The upload context value changes on every progress tick. Only this thin
// wrapper subscribes to it; the (heavy) camera body is memoised and receives
// just the stable executeUpload callback, so progress events re-render the
// wrapper and the small UploadIndicators overlay — never the camera itself.
export default function CameraScreen() {
  const { executeUpload } = useUpload();
  return <CameraScreenBody executeUpload={executeUpload} />;
}

// Upload status badge + subscription-blocked (HTTP 402) banner. Reads the
// upload context itself so per-progress updates stay local to this overlay.
function UploadIndicators() {
  const insets = useSafeAreaInsets();
  const { lastUpload, subscriptionBlocked } = useUpload();
  const { settings } = useSettings();

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

  return (
    <>
      {/* ── Upload status badge ─────────────────────────────────────────── */}
      {/* Shown whatever the "Record History" setting: that only controls the
          stored history list, and upload failures must always be visible.
          The history screen still lists on-device (failed/queued) captures
          when history is off. */}
      {lastUpload && uploadStatusLabel !== "" && !(lastUpload.status === "done" && doneBadgeHidden) && (
        <TouchableOpacity
          style={[styles.uploadStatus, { top: insets.top + (Platform.OS === "web" ? 110 : 70) }]}
          onPress={() => router.push("/history")}
          hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
          accessibilityRole="button"
          accessibilityLabel={`Upload status: ${uploadStatusLabel}`}
          accessibilityHint="Opens upload history"
        >
          <Ionicons name={uploadStatusIcon as any} size={16} color={uploadStatusColor} accessible={false} />
          <Text style={[styles.uploadStatusText, { color: uploadStatusColor }]}>{uploadStatusLabel}</Text>
        </TouchableOpacity>
      )}

      {/* ── Subscription-blocked banner (uploads parked on HTTP 402) ───── */}
      {subscriptionBlocked && (
        <TouchableOpacity
          style={[styles.subBanner, { top: insets.top + (Platform.OS === "web" ? 150 : 108) }]}
          onPress={() => router.push("/settings/subscription")}
          accessibilityRole="button"
          accessibilityLabel="Uploads paused, subscription required. Open subscription settings."
        >
          <Ionicons name="pause-circle-outline" size={16} color="#f59e0b" accessible={false} />
          <Text style={styles.subBannerText} numberOfLines={1}>Uploads paused — subscription required</Text>
          <Ionicons name="chevron-forward" size={14} color="#f59e0b" accessible={false} />
        </TouchableOpacity>
      )}
    </>
  );
}

const CameraScreenBody = React.memo(function CameraScreenBody({ executeUpload }: { executeUpload: ExecuteUpload }) {
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
  const { token, user } = useAuth();
  const userId = user?.id ?? null;
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

  const [cameraPermission, requestCameraPermission, getCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission, getMicPermission] = useMicrophonePermissions();

  const [extMode, setExtMode] = useState<ExtMode>("photo");
  const [facing, setFacing] = useState<CameraType>("back");
  // Flash follows the saved preference: it starts from settings.flashMode and
  // the top-bar toggle writes back to it, so the two can never disagree.
  const flash: FlashMode = settings.flashMode;
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

  // INTERVAL ("timelapse") mode state
  const [isTimelapsing, setIsTimelapsing] = useState(false);
  const [tlCount, setTlCount] = useState(0);
  const tlTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tlPhotos = useRef<string[]>([]);
  const tlGrabbing = useRef(false);
  const intervalRunning = useRef(false);

  // Recording timer
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Scan result
  const [scanUri, setScanUri] = useState<string | null>(null);
  const [scanFileName, setScanFileName] = useState("");
  const [showScanModal, setShowScanModal] = useState(false);

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
  // Progress along the locked sweep direction (degrees, never decreases).
  const panoSweepRef = useRef(0);
  // Signed net rotation since the sweep started (positive = turning left).
  const panoPosition = useRef(0);
  const panoDirection = useRef<PanoDirection | null>(null);
  const panoLastYaw = useRef<number | null>(null);
  // Gyro integration state (native): last sample time in seconds.
  const panoLastGyroT = useRef<number | null>(null);
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

  // Only the camera is asked for up front; the microphone is requested when
  // the user switches to VIDEO (see below), where it is actually needed.
  useEffect(() => {
    if (cameraPermission && !cameraPermission.granted && cameraPermission.canAskAgain) {
      requestCameraPermission();
    }
  }, [cameraPermission?.granted, cameraPermission?.canAskAgain]);

  // ── Focus / app-state gating ──────────────────────────────────────────────
  // Stack screens stay mounted underneath pushed routes (settings, markup,
  // history), so without this the camera, GPS, compass and motion sensors
  // would keep running behind them. `screenActive` drives CameraView `active`
  // (iOS) / mounting (Android, web) and every sensor subscription below.
  const [isFocused, setIsFocused] = useState(true);
  useFocusEffect(useCallback(() => {
    setIsFocused(true);
    return () => setIsFocused(false);
  }, []));
  // iOS reports "inactive" for transient overlays (permission prompts, the
  // notification shade); only a real trip to the background pauses capture.
  const [appActive, setAppActive] = useState(AppState.currentState !== "background");
  useEffect(() => {
    const sub = AppState.addEventListener("change", st => setAppActive(st !== "background"));
    return () => sub.remove();
  }, []);
  const screenActive = isFocused && appActive;

  // Coming back (e.g. from the system Settings page the permission screens
  // link to) re-reads permissions, which the hooks don't do on their own.
  useEffect(() => {
    if (!screenActive) return;
    getCameraPermission().catch(() => {});
    getMicPermission().catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenActive]);

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
    // Paused (not cleared) while another screen is on top or the app is in
    // the background; the last fix stays usable until it ages out.
    if (!screenActive) return;
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
  }, [settingsLoading, settings.saveLocation, screenActive]);

  // Compass bearing (badge, stamp and GPSImgDirection). Location's heading
  // API fuses magnetometer + gyro and gives a true-north heading when a fix
  // is available — unlike a raw magnetometer atan2, which ignores tilt and
  // declination.
  const headingRef = useRef<{ deg: number; ref: "T" | "M" } | null>(null);
  useEffect(() => {
    if (!settings.compassMeta || Platform.OS === "web") { setHeading(null); headingRef.current = null; return; }
    if (!screenActive) return;
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
  }, [settings.compassMeta, locationGranted, screenActive]);

  // Spirit-level — drives the on-screen level guide. `levelBase` is the held
  // orientation (0 portrait, ±90 landscape, 180 upside-down; the UI itself is
  // locked to portrait on native) and `levelRoll` the tilt away from it, so
  // the guide reads correctly whichever way the phone is held.
  const [levelRoll, setLevelRoll] = useState(0);
  const [levelBase, setLevelBase] = useState(0);
  const [levelFlat, setLevelFlat] = useState(false);
  const lastLevel = useRef({ roll: 0, base: 0, flat: false });
  useEffect(() => {
    const reset = () => {
      lastLevel.current = { roll: 0, base: 0, flat: false };
      setLevelRoll(0); setLevelBase(0); setLevelFlat(false);
    };
    if (!settings.showLevelGuide) { reset(); return; }
    if (!screenActive) return;

    // Low-pass the up vector so hand shake doesn't make the guide jitter.
    const up = { x: 0, y: 1, z: 0, seeded: false };
    const pushUp = (ux: number, uy: number, uz: number, screenAngle = 0) => {
      if (!up.seeded) { up.x = ux; up.y = uy; up.z = uz; up.seeded = true; }
      else {
        const k = 0.3;
        up.x += (ux - up.x) * k; up.y += (uy - up.y) * k; up.z += (uz - up.z) * k;
      }
      // Rotate into screen coordinates when the page itself has rotated (web).
      const a = (screenAngle * Math.PI) / 180;
      const sx = up.x * Math.cos(a) - up.y * Math.sin(a);
      const sy = up.x * Math.sin(a) + up.y * Math.cos(a);
      const lv = levelFromUp(sx, sy, up.z);
      const next = lv
        ? { roll: Math.round(lv.deviation), base: lv.base, flat: false }
        : { roll: 0, base: lastLevel.current.base, flat: true };
      // Only re-render on a real change — not on every sensor tick.
      const prev = lastLevel.current;
      if (next.roll === prev.roll && next.base === prev.base && next.flat === prev.flat) return;
      lastLevel.current = next;
      setLevelRoll(next.roll); setLevelBase(next.base); setLevelFlat(next.flat);
    };

    if (Platform.OS === "web") {
      // deviceorientation's beta/gamma (Z-X'-Y'' Euler angles) give the "up"
      // vector in device coordinates; unlike raw devicemotion, its signs are
      // consistent across browsers. The page rotates with the device on web,
      // so compensate for the current screen angle.
      const handler = (e: any) => {
        if (e?.beta == null || e?.gamma == null) return;
        const b = (e.beta * Math.PI) / 180;
        const g = (e.gamma * Math.PI) / 180;
        const w: any = typeof window !== "undefined" ? window : null;
        const screenAngle = Number(w?.screen?.orientation?.angle ?? w?.orientation ?? 0) || 0;
        pushUp(-Math.sin(g) * Math.cos(b), Math.sin(b), Math.cos(g) * Math.cos(b), screenAngle);
      };
      window.addEventListener("deviceorientation", handler);
      return () => window.removeEventListener("deviceorientation", handler);
    }

    let sub: { remove: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const DeviceMotion = await getDeviceMotion();
        if (!DeviceMotion || cancelled) return;
        const available = await DeviceMotion.isAvailableAsync().catch(() => false);
        if (!available || cancelled) return;
        // No requestPermissionsAsync here: on iOS it runs a CMPedometer query
        // and raises a "Motion & Fitness" prompt, yet CMMotionManager device
        // motion needs no authorisation (Android has no permission either).
        DeviceMotion.setUpdateInterval(60);
        const created = DeviceMotion.addListener(({ accelerationIncludingGravity: g }) => {
          // expo-sensors reports gravity pointing DOWN on both platforms (iOS
          // natively; Android as accel − 2·gravity), in device axes (x → right
          // edge, y → top edge). "Up" is its negation.
          if (!g) return;
          pushUp(-g.x, -g.y, -g.z);
        });
        if (cancelled) created.remove();
        else sub = created;
      } catch { /* sensor unavailable */ }
    })();
    return () => { cancelled = true; sub?.remove(); };
  }, [settings.showLevelGuide, screenActive]);

  // Give a light haptic tick the moment the guide snaps to level.
  const wasLevel = useRef(false);
  useEffect(() => {
    if (!settings.showLevelGuide) { wasLevel.current = false; return; }
    const level = !levelFlat && Math.abs(levelRoll) <= LEVEL_TOLERANCE_DEG;
    if (level && !wasLevel.current && Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    wasLevel.current = level;
  }, [levelRoll, levelFlat, settings.showLevelGuide]);

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
    if (Platform.OS !== "web" || !settings.volumeKeyShutter || !screenActive) return;
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
  }, [settings.volumeKeyShutter, screenActive]);

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
    setZoom(() => Math.min(1, Math.max(0, baseZoom.current + (scale - 1) * 0.4)));
  }, []);

  const pinchGesture = Gesture.Pinch()
    .onStart(() => { scheduleOnRN(saveBaseZoom); })
    .onUpdate((e) => { scheduleOnRN(applyZoom, e.scale); })
    .onEnd(() => { scheduleOnRN(saveBaseZoom); });

  const confirmUpload = useCallback((): Promise<boolean> => {
    if (!settings.promptBeforeUpload) return Promise.resolve(true);
    return new Promise(resolve => {
      Alert.alert("Upload to Cloud?", "Send this file to your connected cloud storage?", [
        { text: "Skip", style: "cancel", onPress: () => resolve(false) },
        { text: "Upload", onPress: () => resolve(true) },
      ]);
    });
  }, [settings.promptBeforeUpload]);

  // Witness mode fires only once a capture has REALLY been uploaded — it is
  // passed to executeUpload as its onUploaded callback, never on queueing.
  const notifyWitness = useCallback((fileName: string) => {
    sendWitnessNotice({
      enabled: settings.witnessOnSuccess,
      witnessEmail: settings.witnessEmail,
      token,
      fileName,
    });
  }, [settings.witnessOnSuccess, settings.witnessEmail, token]);

  /**
   * Hand a finished capture off: a copy to the photo library (when enabled, or
   * always for the "Don't upload" target), then the upload queue. Callers
   * `void` this — it may wait on the upload-target lookup or a confirm prompt,
   * and the shutter must not. The queue persists the file, applies the
   * Wi-Fi-only rule itself and retries later, so nothing is dropped here.
   */
  const doUpload = useCallback(async (
    uri: string,
    fileName: string,
    type: "image" | "video",
    opts?: { skipMarkup?: boolean },
  ) => {
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

      if (type === "image" && settings.photoMarkup && !opts?.skipMarkup) {
        // The markup screen performs the actual upload — and the witness
        // notice, for whichever version it really uploads.
        router.push({ pathname: "/markup", params: { uri, fileName } });
      } else {
        // executeUpload persists the capture into the queue and returns
        // quickly; the network transfer continues in the background. The
        // witness is told only when this file has actually been uploaded.
        executeUpload(uri, fileName, type, token, target.ids, onDeleteLocal, () => notifyWitness(fileName))
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

  // Self-timer countdown (with the optional voice countdown — the "Voice
  // Countdown" setting, settings.timerBeep). Cancellable: tapping the shutter
  // or the cancel button during it aborts the shot and silences the voice.
  // Resolves true when it ran to zero, false when cancelled.
  const countdownCancel = useRef<(() => void) | null>(null);
  const stopSpeech = useCallback(() => {
    try {
      if (Platform.OS === "web") {
        if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
      } else {
        Speech.stop().catch(() => {});
      }
    } catch { /* ignore tts errors */ }
  }, []);
  const cancelCountdown = useCallback(() => {
    countdownCancel.current?.();
  }, []);
  const runCountdown = useCallback(async (seconds: number): Promise<boolean> => {
    let cancelled = false;
    let wake: (() => void) | null = null;
    countdownCancel.current = () => {
      cancelled = true;
      stopSpeech();
      wake?.();
    };
    try {
      for (let s = seconds; s > 0 && !cancelled; s--) {
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
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        }
        await new Promise<void>(r => {
          const t = setTimeout(() => { wake = null; r(); }, 1000);
          wake = () => { clearTimeout(t); wake = null; r(); };
        });
      }
    } finally {
      countdownCancel.current = null;
      setCountdown(null);
    }
    return !cancelled;
  }, [settings.timerBeep, stopSpeech]);

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
    // Cap the composition's long edge (in output pixels) so the offscreen
    // render stays within a sane memory/time budget. A typical 12 MP phone
    // photo (4032 px) passes through at full size.
    const MAX_EDGE = 4096;
    const w = opts.width > 0 ? opts.width : 1080;
    const h = opts.height > 0 ? opts.height : 1440;
    const long = Math.max(w, h);
    const scale = long > MAX_EDGE ? MAX_EDGE / long : 1;
    const renderW = Math.max(1, Math.round(w * scale));
    const renderH = Math.max(1, Math.round(h * scale));
    const shot = viewShotSize(renderW, renderH);
    bakeCaptured.current = false;
    return new Promise((resolve) => {
      // Never strand an earlier caller: a superseded bake keeps its original.
      bakeResolver.current?.(null);
      bakeResolver.current = resolve;
      setBakeConfig({
        uri: opts.uri,
        renderW,
        renderH,
        pad: Math.round(renderW * 0.025),
        fs: Math.round(renderW * 0.028),
        stampLines: opts.stampLines,
        overlay: opts.overlay,
        dp: shot.dpPerPx,
        capture: shot.capture,
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
        ...bakeConfig.capture,
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
  // A sweep captures a frame every PANO_STEP_DEG of yaw (recording the angle
  // each was actually taken at), then composites the frames' strips into one
  // wide image in the order they sit in the scene (see lib/panorama.ts).

  const panoAtEnd = useCallback(() =>
    panoSweepRef.current >= PANO_MAX_SWEEP_DEG || panoFrames.current.length >= PANO_MAX_FRAMES, []);
  const panoFinishing = useRef(false);
  const panoGrabPromise = useRef<Promise<void> | null>(null);

  /** Grab one frame mid-sweep. Re-entrancy-guarded — the sensor can tick again
   *  while takePictureAsync is still in flight (callers check panoGrabbing
   *  first so a skipped grab never moves the next-capture threshold). */
  const panoGrabFrame = useCallback(async () => {
    if (!panoActive.current || panoGrabbing.current) return;
    if (panoFrames.current.length >= PANO_MAX_FRAMES) { finishPanoRef.current(); return; }
    panoGrabbing.current = true;
    // The exposure starts now, so this is where the frame points.
    const angle = panoSweepRef.current;
    const run = (async () => {
      try {
        // No skipProcessing: unprocessed frames keep the sensor's native
        // orientation (sideways on most Android phones) and RN's <Image> does
        // not apply EXIF rotation, so the strips would come out rotated.
        const photo = await cameraRef.current?.takePictureAsync({
          quality: 0.8,
          shutterSound: false,
        });
        if (photo?.uri) {
          if (panoActive.current) {
            panoFrames.current.push({ uri: photo.uri, width: photo.width ?? 0, height: photo.height ?? 0, angle });
            setPanoFrameCount(panoFrames.current.length);
            if (Platform.OS !== "web") {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
            }
          } else {
            deleteTempFile(photo.uri);
          }
        }
      } catch { /* drop this frame and keep sweeping */ }
      finally { panoGrabbing.current = false; }
    })();
    panoGrabPromise.current = run;
    await run;
    if (panoActive.current && !panoFinishing.current && panoAtEnd()) finishPanoRef.current();
  }, [panoAtEnd]);

  /** Fold the signed rotation since the start into sweep progress, capturing
   *  a frame at every step and finishing at the limits. */
  const panoOnPosition = useCallback((position: number) => {
    if (!panoActive.current || panoFinishing.current) return;
    panoPosition.current = position;
    if (!panoDirection.current) {
      const dir = directionFromPosition(position);
      if (!dir) return;
      panoDirection.current = dir;
    }
    // Progress along the locked direction; swinging back doesn't count.
    const progress = panoDirection.current === "rtl" ? position : -position;
    if (progress <= panoSweepRef.current) return;
    panoSweepRef.current = progress;
    setPanoSweep(Math.round(progress));

    if (panoGrabbing.current) return; // the in-flight grab re-checks the end
    if (progress >= panoNextCaptureAt.current || panoAtEnd()) {
      panoNextCaptureAt.current = progress + PANO_STEP_DEG;
      void panoGrabFrame();
    }
  }, [panoGrabFrame, panoAtEnd]);

  /** Absolute yaw source (rotation.alpha / web alpha): fold into position. */
  const panoOnYaw = useCallback((yawDeg: number) => {
    if (!panoActive.current) return;
    const { position, accepted } = accumulateSweep(panoLastYaw.current, yawDeg, panoPosition.current);
    panoLastYaw.current = yawDeg;
    if (accepted) panoOnPosition(position);
  }, [panoOnPosition]);

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
      // No requestPermissionsAsync — see the level guide above (it would raise
      // an unneeded iOS Motion & Fitness prompt).
      DeviceMotion.setUpdateInterval(60);
      panoLastGyroT.current = null;
      panoSensorSub.current = DeviceMotion.addListener(({ rotation, rotationRate, accelerationIncludingGravity: g }) => {
        // Preferred: integrate the gyro rate about the gravity axis. Unlike
        // the Euler yaw in rotation.alpha, this doesn't hit gimbal lock with
        // the phone held upright, and works in portrait or landscape.
        const gn = g ? Math.hypot(g.x, g.y, g.z) : 0;
        if (rotationRate && gn > 1) {
          // Device-axis angular velocity (deg/s, right-handed). expo-sensors
          // maps the axes differently per platform: iOS alpha/beta/gamma =
          // z/y/x, Android = x/y/z.
          const [wx, wy, wz] = Platform.OS === "ios"
            ? [rotationRate.gamma, rotationRate.beta, rotationRate.alpha]
            : [rotationRate.alpha, rotationRate.beta, rotationRate.gamma];
          // Gravity points down in expo-sensors' DeviceMotion on both platforms.
          const yawRate = -(wx * g!.x + wy * g!.y + wz * g!.z) / gn;
          const t = rotationRate.timestamp;
          const last = panoLastGyroT.current;
          panoLastGyroT.current = t;
          if (last != null) {
            const dt = t - last;
            if (dt > 0 && dt < 0.5) panoOnPosition(panoPosition.current + yawRate * dt);
          }
          return;
        }
        if (rotation?.alpha == null) return;
        panoOnYaw(rotation.alpha * (180 / Math.PI));
      });
      return true;
    } catch { return false; }
  }, [panoOnYaw, panoOnPosition, panoStopSensor]);

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
        ...panoConfig.capture,
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
    if (panoConfig && panoSettled.current >= panoConfig.slices.length) capturePanoView();
  }, [panoConfig, capturePanoView]);

  // Backstop in case an onLoad never fires. Scales with frame count so a long
  // sweep isn't cut off early.
  useEffect(() => {
    if (!panoConfig) return;
    const t = setTimeout(abandonPanoCompose, 4000 + panoConfig.slices.length * 500);
    return () => clearTimeout(t);
  }, [panoConfig, abandonPanoCompose]);

  const composePano = useCallback((frames: PanoFrame[], direction: PanoDirection): Promise<string | null> => {
    const layout = panoLayout({ frames, direction });
    if (layout.slices.length === 0) return Promise.resolve(null);
    const shot = viewShotSize(layout.outW, layout.outH);
    panoCaptured.current = false;
    panoSettled.current = 0;
    return new Promise((resolve) => {
      panoResolver.current?.(null);
      panoResolver.current = resolve;
      setPanoConfig({ ...layout, frames, dp: shot.dpPerPx, capture: shot.capture });
    });
  }, []);

  const finishPano = useCallback(async () => {
    if (!panoActive.current || panoFinishing.current) return;
    panoFinishing.current = true;
    panoStopSensor();
    // Let a frame that is already being exposed land — it is the sweep's
    // final edge.
    if (panoGrabPromise.current) await panoGrabPromise.current.catch(() => {});
    panoActive.current = false;
    panoFinishing.current = false;
    panoGrabPromise.current = null;
    setIsPanoCapturing(false);

    const frames = [...panoFrames.current];
    // No sensor direction (timed fallback, or barely moved): the on-screen
    // hint asks for a left-to-right pan.
    const direction: PanoDirection = panoDirection.current ?? "ltr";
    panoFrames.current = [];
    setPanoFrameCount(0);
    setPanoSweep(0);
    panoSweepRef.current = 0;
    panoPosition.current = 0;
    panoDirection.current = null;
    panoLastYaw.current = null;
    panoLastGyroT.current = null;

    if (frames.length === 0) return;

    let uri = frames[0]!.uri;
    let stitched = false;
    if (frames.length >= PANO_MIN_FRAMES) {
      setPanoComposing(true);
      const composed = await composePano(frames, direction);
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
      // Too little movement for a panorama — save one ordinary frame.
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
    panoPosition.current = 0;
    panoDirection.current = null;
    panoLastYaw.current = null;
    panoLastGyroT.current = null;
    panoNextCaptureAt.current = PANO_STEP_DEG;
    panoFinishing.current = false;
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
      // we assume the nominal step per tick instead of measuring it.
      panoTimer.current = setInterval(() => {
        if (!panoActive.current || panoFinishing.current) return;
        panoSweepRef.current += PANO_STEP_DEG;
        setPanoSweep(Math.round(panoSweepRef.current));
        if (panoGrabbing.current) return; // the in-flight grab re-checks the end
        void panoGrabFrame();
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

  /**
   * Burn the stamp and/or the selected filter's tint into a freshly captured
   * photo (native can only approximate a filter with a tint overlay — the same
   * one shown in the live preview). Shared by PHOTO and INTERVAL. Returns the
   * uri to keep: the baked copy (the raw frame is deleted) or, when there's
   * nothing to bake or the bake failed, the original.
   */
  const bakeCapture = useCallback(async (photo: { uri: string; width?: number; height?: number }) => {
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

    let uri = photo.uri;
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
    return { uri, baked, wantStamp, stampedLocation };
  }, [settings.stampPhotos, settings.saveLocation, selectedFilter, heading, bakeImageNative]);

  // Single capture cycle (screen flash → snap → stamp/strip), then a
  // background hand-off to the photo library / upload queue. Resolves as soon
  // as the photo is on disk so the shutter is free for the next shot.
  // The self-timer runs once at the start of a burst, not on every shot.
  const captureOne = useCallback(async (indexLabel?: string, opts?: { skipMarkup?: boolean }) => {
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

    const { uri, baked, wantStamp, stampedLocation } = await bakeCapture(photo);

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
    void doUpload(uri, fileName, "image", opts);
  }, [settings.stripExif, screenFlashOn, screenFlashOff, buildGpsExif, bakeCapture, doUpload, heading, showToast]);

  // Mirrors screenActive for async loops (burst) that outlive a render.
  const screenActiveRef = useRef(screenActive);
  useEffect(() => { screenActiveRef.current = screenActive; }, [screenActive]);

  const handlePhotoCapture = useCallback(async () => {
    // A tap during the self-timer cancels it.
    if (countdownCancel.current) { cancelCountdown(); return; }
    // INTERVAL / PANO own the camera while running (the web keyboard shutter
    // can reach here in any mode).
    if (busyRef.current || recordingRef.current || intervalRunning.current || panoActive.current) return;
    busyRef.current = true;
    try {
      if (settings.timerSeconds > 0) {
        const completed = await runCountdown(settings.timerSeconds);
        if (!completed) return;
      }
      const n = Math.max(1, settings.burstCount | 0);
      // Markup opens one screen per photo; a burst would stack N of them. Burst
      // frames skip markup and upload as shot.
      const skipMarkup = n > 1 && settings.photoMarkup;
      if (skipMarkup) showToast(`Burst: markup skipped — ${n} originals will upload`, 2600);
      for (let i = 0; i < n; i++) {
        if (!screenActiveRef.current) break; // left the camera mid-burst
        await captureOne(n > 1 ? String(i + 1).padStart(2, "0") : undefined, { skipMarkup });
        if (n > 1 && i < n - 1) {
          await new Promise(r => setTimeout(r, Math.max(0, settings.burstDelay) * 1000));
        }
      }
    } catch (err: any) {
      Alert.alert("Capture Failed", err?.message ?? "Could not take photo.");
    } finally { busyRef.current = false; }
  }, [settings.burstCount, settings.burstDelay, settings.timerSeconds, settings.photoMarkup, runCountdown, cancelCountdown, captureOne, showToast]);

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
    const recording = cameraRef.current?.recordAsync({
      maxDuration,
      // Stop before the server's upload cap so the clip can actually upload.
      maxFileSize: MAX_RECORDING_BYTES,
      ...(codec ? { codec } : {}),
    });
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
  // unmounts (e.g. navigating home mid-recording or mid-INTERVAL). Without
  // this, the INTERVAL setInterval keeps firing takePictureAsync on a torn-down
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
      countdownCancel.current?.();
    };
  }, []);

  // Leaving the camera (another screen pushed on top, or the app sent to the
  // background) must not silently cut a capture short or leave it running
  // blind: a recording is stopped — its promise then resolves with the file,
  // which is saved/queued as usual — a pano sweep is finished and stitched, a
  // self-timer is cancelled. The INTERVAL series is stopped and offered for
  // upload by an effect next to stopInterval.
  useEffect(() => {
    if (screenActive) return;
    countdownCancel.current?.();
    if (recordingRef.current && !recordStopping.current) {
      recordStopping.current = true;
      try { cameraRef.current?.stopRecording(); } catch { /* already stopped */ }
    }
    if (panoActive.current) finishPanoRef.current();
  }, [screenActive]);

  // VIDEO needs the microphone for sound. Ask when the user switches to it;
  // if it's refused, record silently (CameraView `mute`) rather than failing —
  // Android's recorder errors out when it can't open the mic — and say so once.
  const micNoticeShown = useRef(false);
  const micGranted = micPermission?.granted === true;
  useEffect(() => {
    if (extMode !== "video" || !micPermission || micPermission.granted) return;
    let cancelled = false;
    (async () => {
      let perm = micPermission;
      if (perm.canAskAgain) {
        try { perm = await requestMicPermission(); } catch { /* treat as denied */ }
      }
      if (cancelled || perm.granted || micNoticeShown.current) return;
      micNoticeShown.current = true;
      const canOpenSettings = !perm.canAskAgain && Platform.OS !== "web";
      Alert.alert(
        "Videos Will Be Silent",
        "Microphone access is off for KKamera, so videos will be recorded without sound.",
        canOpenSettings
          ? [
            { text: "OK", style: "cancel" },
            { text: "Open Settings", onPress: () => { Linking.openSettings().catch(() => {}); } },
          ]
          : [{ text: "OK" }],
      );
    })();
    return () => { cancelled = true; };
  // Only re-run on the mode switch / a real permission change, not every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extMode, micPermission?.granted, micPermission?.canAskAgain]);

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

  // Closing a scan throws the scanned page away.
  const discardScan = useCallback(() => {
    setShowScanModal(false);
    deleteTempFile(scanUri);
    setScanUri(null);
  }, [scanUri]);

  // Retake: throw the page away and relaunch the OS scanner. The scanner
  // presents its own full-screen UI, which iOS refuses to show while our modal
  // is still animating out — so wait for the dismissal first.
  const retakeScan = useCallback(() => {
    discardScan();
    setTimeout(() => { void handleScan(); }, 450);
  }, [discardScan, handleScan]);

  // INTERVAL (time-lapse) mode: a photo every INTERVAL_SECONDS until stopped,
  // then the series is uploaded as individual photos (no video is made). Each
  // frame gets the same stamp / filter bake as a normal photo.
  const bakeCaptureRef = useRef(bakeCapture);
  useEffect(() => { bakeCaptureRef.current = bakeCapture; }, [bakeCapture]);
  const buildGpsExifRef = useRef(buildGpsExif);
  useEffect(() => { buildGpsExifRef.current = buildGpsExif; }, [buildGpsExif]);

  const startInterval = useCallback(() => {
    if (intervalRunning.current) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    intervalRunning.current = true;
    setIsTimelapsing(true);
    setTlCount(0);
    tlPhotos.current = [];
    tlTimer.current = setInterval(async () => {
      if (tlGrabbing.current || !intervalRunning.current) return; // previous shot still in flight
      tlGrabbing.current = true;
      try {
        const additionalExif = buildGpsExifRef.current();
        const photo = await cameraRef.current?.takePictureAsync({
          quality: 0.8,
          exif: !settings.stripExif,
          shutterSound: false,
          ...(additionalExif ? { additionalExif } : {}),
        });
        if (photo?.uri) {
          const { uri } = await bakeCaptureRef.current(photo);
          tlPhotos.current.push(uri);
          setTlCount(c => c + 1);
        }
      } catch { /* skip this shot and keep going */ }
      finally { tlGrabbing.current = false; }
    }, INTERVAL_SECONDS * 1000);
  }, [settings.stripExif]);

  const stopInterval = useCallback(async () => {
    if (!intervalRunning.current) return;
    intervalRunning.current = false;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    if (tlTimer.current) { clearInterval(tlTimer.current); tlTimer.current = null; }
    // Let a frame that's mid-capture/bake land in the series.
    for (let i = 0; i < 40 && tlGrabbing.current; i++) await new Promise(r => setTimeout(r, 100));
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
        // Library copy BEFORE queueing: the queue may move the file.
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
  }, [settings.deleteLocalAfterUpload, settings.saveToCameraRoll, getUploadTarget, executeUpload, token, showToast]);

  const handleTimelapse = useCallback(() => {
    if (intervalRunning.current) void stopInterval();
    else startInterval();
  }, [startInterval, stopInterval]);

  // An INTERVAL series can't keep shooting with the camera paused, so leaving
  // the screen ends it and offers the frames for upload.
  useEffect(() => {
    if (!screenActive && intervalRunning.current) void stopInterval();
  }, [screenActive, stopInterval]);

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
    updateSetting("flashMode", cycle[(cycle.indexOf(flash) + 1) % 3]!);
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

  const activeFilter = FILTERS[selectedFilter];
  const filterOverlay = Platform.OS !== "web" ? (activeFilter?.overlay ?? null) : null;
  const filterCssWeb = Platform.OS === "web" ? (activeFilter?.css ?? null) : null;

  if (!cameraPermission) return <View style={styles.container} />;

  if (!cameraPermission.granted) {
    // Once the user has refused for good, the OS won't show the prompt again —
    // the only way back is the app's page in system Settings.
    const blocked = !cameraPermission.canAskAgain && Platform.OS !== "web";
    return (
      <View style={[styles.container, styles.centeredContainer]}>
        <Ionicons name="camera-outline" size={56} color={PRIMARY} accessible={false} />
        <Text style={styles.permText}>
          {blocked
            ? "Camera access is turned off for KKamera. Turn it on in Settings to take photos and videos."
            : "Camera access is needed to take photos and videos."}
        </Text>
        <TouchableOpacity
          style={styles.permBtn}
          accessibilityRole="button"
          onPress={() => {
            if (blocked) Linking.openSettings().catch(() => {});
            else requestCameraPermission();
          }}
        >
          <Text style={styles.permBtnText}>{blocked ? "Open Settings" : "Grant Camera Access"}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.permSkip}
          onPress={() => router.push("/settings")}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
        >
          <Text style={styles.permSkipText}>Go to Settings instead</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!hasAccess) {
    // Only ever show the live store price (never a hard-coded one); the "/year"
    // suffix is only added when the package really is the annual one.
    const paywallPkg = rcSub.offerings?.current?.availablePackages.find(
      (p) => p.packageType === "ANNUAL" || p.identifier === "$rc_annual",
    );
    const paywallPrice = paywallPkg?.product.priceString ?? null;
    return (
      <View style={[styles.container, styles.centeredContainer]}>
        <StatusBar barStyle="light-content" />
        <Ionicons name="lock-closed" size={52} color={PRIMARY} style={{ marginBottom: 20 }} accessible={false} />
        <Text style={styles.paywallTitle} accessibilityRole="header">Subscription Required</Text>
        <Text style={styles.paywallBody}>Your free trial has ended.{"\n"}Subscribe to keep using KKamera.</Text>
        <TouchableOpacity
          style={styles.paywallBtn}
          onPress={() => router.push("/settings/subscription")}
          accessibilityRole="button"
        >
          <Ionicons name="card-outline" size={18} color="white" accessible={false} />
          <Text style={styles.paywallBtnText}>
            {paywallPrice ? `View Subscription — ${paywallPrice}/year` : "View Subscription"}
          </Text>
        </TouchableOpacity>
        {/* Never a dead end: account, sign-out, clouds and queued captures stay reachable. */}
        <TouchableOpacity
          style={[styles.permSkip, { marginTop: 16 }]}
          onPress={() => router.push("/history")}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
        >
          <Text style={styles.permSkipText}>Upload history</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.permSkip}
          onPress={() => router.push("/settings")}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
        >
          <Text style={styles.permSkipText}>Settings & sign out</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isVideoMode = currentModeConfig.isVideo && extMode !== "timelapse";
  // iOS pauses the session via `active`; elsewhere that prop is ignored, so
  // the preview is unmounted while another screen is on top — but never
  // mid-recording, which must be allowed to finalise its file first.
  const cameraMounted = Platform.OS === "ios" || screenActive || isRecording;
  const captureIsActive = isRecording || isTimelapsing || isPanoCapturing || panoComposing;

  const shutterLabel =
    countdown != null ? "Cancel self-timer"
    : extMode === "scan" ? "Scan document"
    : extMode === "pano" ? (isPanoCapturing ? "Finish panorama" : panoComposing ? "Stitching panorama" : "Start panorama")
    : extMode === "timelapse" ? (isTimelapsing ? "Stop interval capture" : "Start interval capture")
    : isVideoMode ? (isRecording ? "Stop recording" : "Start recording")
    : settings.timerSeconds > 0 ? `Take photo in ${settings.timerSeconds} seconds`
    : "Take photo";

  // Settle the mode strip where a user scroll stopped. Changing mode re-centres
  // via the extMode effect; otherwise (same mode, or a mode change refused
  // mid-capture) snap straight back onto the active mode so the strip never
  // rests between items or on a mode that isn't the one in use.
  const settleModeStrip = (x: number) => {
    if (programmaticScroll.current) return; // ignore scrolls we triggered ourselves
    const idx = Math.round(x / ITEM_W);
    const clamped = Math.max(0, Math.min(idx, STRIP_MODES.length - 1));
    const target = STRIP_MODES[clamped]!.mode;
    if (!captureIsActive && target !== extMode) {
      setExtMode(target);
      return;
    }
    const activeIdx = STRIP_MODES.findIndex(m => m.mode === extMode);
    if (activeIdx >= 0 && Math.abs(x - activeIdx * ITEM_W) > 0.5) scrollToMode(activeIdx);
  };

  // A drag that ends without momentum (slow Android drags, web) never fires
  // onMomentumScrollEnd, so settle shortly after the finger lifts unless a
  // momentum phase starts — which then settles on its own end.
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current); }, []);
  const clearSettleTimer = () => {
    if (settleTimer.current) { clearTimeout(settleTimer.current); settleTimer.current = null; }
  };
  const handleModeScrollEndDrag = (e: any) => {
    const x = e?.nativeEvent?.contentOffset?.x ?? 0;
    clearSettleTimer();
    settleTimer.current = setTimeout(() => { settleTimer.current = null; settleModeStrip(x); }, 150);
  };
  const handleModeMomentumEnd = (e: any) => {
    clearSettleTimer();
    settleModeStrip(e?.nativeEvent?.contentOffset?.x ?? 0);
  };

  return (
    <GestureDetector gesture={pinchGesture}>
      <View style={styles.container}>
        <StatusBar barStyle="light-content" />
        {trialDaysLeft !== null && <TrialBanner daysLeft={trialDaysLeft} />}

        {cameraMounted && (
          <CameraView
            ref={cameraRef}
            style={[
              StyleSheet.absoluteFill,
              settings.flipPreview ? { transform: [{ rotate: "180deg" }] } : null,
              // Web: real GPU colour-grade on the live preview.
              filterCssWeb ? ({ filter: filterCssWeb } as any) : null,
            ]}
            // iOS: pauses the capture session while another screen is on top
            // or the app is backgrounded (other platforms unmount instead —
            // see cameraMounted). Held on until a recording has finalised.
            active={screenActive || isRecording}
            facing={facing}
            flash={flash}
            // VIDEO with flash "on" keeps the torch lit (photo flash can't
            // light a video). Rear camera only — the front has no torch.
            enableTorch={isVideoMode && flash === "on" && facing === "back" && (screenActive || isRecording)}
            // Without microphone access, record silently instead of failing.
            mute={!micGranted}
            zoom={zoom}
            mode={cameraViewMode}
            mirror={facing === "front" && settings.mirrorFrontCamera}
            videoQuality={VIDEO_QUALITY[settings.videoQuality] ?? "1080p"}
            // iOS: shoot landscape photos/videos when the phone is turned, even
            // though the app UI is locked to portrait.
            responsiveOrientationWhenOrientationLocked
            selectedLens={onUltraWide ? ultraWideLens! : undefined}
            onAvailableLensesChanged={handleAvailableLenses}
          />
        )}

        {/* Preview overlays. expo-camera 17 doesn't support <CameraView>
            children (it warns and can crash), so they are siblings layered on
            top; pointerEvents="none" lets pinch-to-zoom reach the container. */}
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
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

          {/* Level guide — the whole guide turns with the way the phone is
              held (the UI is portrait-locked), the tilt line follows the true
              horizon, and it snaps green within LEVEL_TOLERANCE_DEG. */}
          {settings.showLevelGuide && (
            <View style={[StyleSheet.absoluteFill, styles.levelContainer]} pointerEvents="none">
              {!levelFlat && (
                <>
                  {/* Reference line — the held orientation's horizontal */}
                  <View style={[
                    styles.levelRefLine,
                    { transform: [{ rotate: `${levelBase}deg` }] },
                    Math.abs(levelRoll) <= LEVEL_TOLERANCE_DEG && styles.levelRefLineActive,
                  ]} />
                  {/* Horizon line — rotates against the device's tilt */}
                  <View style={[
                    styles.levelLine,
                    { transform: [{ rotate: `${levelBase + levelRoll}deg` }] },
                    Math.abs(levelRoll) <= LEVEL_TOLERANCE_DEG && styles.levelLineActive,
                  ]} />
                </>
              )}
              <View style={[
                styles.levelDot,
                !levelFlat && Math.abs(levelRoll) <= LEVEL_TOLERANCE_DEG && styles.levelDotActive,
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
                  Tap the shutter, then pan slowly left or right
                </Text>
              )}
            </View>
          )}

          {/* INTERVAL shot counter */}
          {isTimelapsing && (
            <View style={[styles.tlCounter]} pointerEvents="none">
              <Ionicons name="timer-outline" size={16} color={PRIMARY} />
              <Text style={styles.tlCountText}>{tlCount} photo{tlCount === 1 ? "" : "s"} · every {INTERVAL_SECONDS} s</Text>
            </View>
          )}
        </View>

        {/* ── Top Bar ─────────────────────────────────────────────────────── */}
        <View style={[styles.topBar, { paddingTop: insets.top + (Platform.OS === "web" ? 20 : 4) }]}>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={cycleFlash}
            hitSlop={ICON_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={`Flash: ${flash}`}
            accessibilityHint="Cycles flash between auto, on and off"
          >
            <Ionicons name={flashIcon as any} size={21} color={flash === "on" ? "#FFD700" : "white"} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={toggleLevelGuide}
            hitSlop={ICON_HIT_SLOP}
            accessibilityRole="switch"
            accessibilityLabel="Level guide"
            accessibilityState={{ checked: settings.showLevelGuide }}
          >
            <MaterialCommunityIcons name="spirit-level" size={19} color={settings.showLevelGuide ? PRIMARY : "white"} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconBtn}
            hitSlop={ICON_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={`Grid: ${GRID_LABEL[settings.gridType] ?? settings.gridType}`}
            accessibilityHint="Cycles the composition grid"
            accessibilityState={{ selected: settings.gridType !== "off" }}
            onPress={() => {
            const next = settings.gridType === "off" ? "thirds" : settings.gridType === "thirds" ? "golden" : settings.gridType === "golden" ? "square" : settings.gridType === "square" ? "diagonal" : "off";
            updateSetting("gridType", next);
          }}>
            <Ionicons name="grid-outline" size={18} color={settings.gridType !== "off" ? PRIMARY : "white"} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconBtn}
            hitSlop={ICON_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={settings.timerSeconds > 0 ? `Self-timer: ${settings.timerSeconds} seconds` : "Self-timer: off"}
            accessibilityHint="Cycles the self-timer between off, 3 and 10 seconds"
            accessibilityState={{ selected: settings.timerSeconds > 0 }}
            onPress={() => {
            const next = settings.timerSeconds === 0 ? 3 : settings.timerSeconds === 3 ? 10 : 0;
            updateSetting("timerSeconds", next);
          }}>
            <Ionicons name="timer-outline" size={19} color={settings.timerSeconds > 0 ? PRIMARY : "white"} />
            {settings.timerSeconds > 0 && (
              <Text style={styles.timerBadge}>{settings.timerSeconds}s</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => setShowFilters(v => !v)}
            hitSlop={ICON_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel="Filters"
            accessibilityState={{ expanded: showFilters }}
          >
            <Feather name="sliders" size={18} color={showFilters ? PRIMARY : "white"} />
          </TouchableOpacity>
          {(isRecording) && (
            <View
              style={styles.recordingBadge}
              accessible
              accessibilityLabel={`Recording, ${formatTime(recordSeconds)}`}
            >
              <View style={styles.recordingDot} />
              <Text style={styles.recordingTime}>{formatTime(recordSeconds)}</Text>
            </View>
          )}
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => router.push("/settings")}
            hitSlop={ICON_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            <Ionicons name="settings-outline" size={21} color="white" />
          </TouchableOpacity>
        </View>

        <UploadIndicators />

        {/* ── Filter panel ────────────────────────────────────────────────── */}
        {showFilters && (
          <View style={[styles.filterPanel, { top: insets.top + (Platform.OS === "web" ? 100 : 60) }]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScroll}>
              {FILTERS.map((f, i) => (
                <TouchableOpacity
                  key={f.name}
                  style={styles.filterChip}
                  onPress={() => setSelectedFilter(i)}
                  accessibilityRole="button"
                  accessibilityLabel={`${f.name} filter`}
                  accessibilityState={{ selected: selectedFilter === i }}
                >
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
            <TouchableOpacity
              style={styles.zoomSideBtn}
              onPress={() => selectZoom(0, true)}
              hitSlop={ZOOM_HIT_SLOP}
              accessibilityRole="button"
              accessibilityLabel="Zoom 0.5 times, ultra-wide"
              accessibilityState={{ selected: onUltraWide && zoom <= 0.02 }}
            >
              <Text style={[styles.zoomSideLabel, onUltraWide && zoom <= 0.02 && styles.zoomSideLabelActive]}>
                0.5×
              </Text>
            </TouchableOpacity>
          )}
          {zoomExpanded && ZOOM_LEVELS.map(({ value, label }) => (
            <TouchableOpacity
              key={value}
              style={styles.zoomSideBtn}
              onPress={() => selectZoom(value)}
              hitSlop={ZOOM_HIT_SLOP}
              accessibilityRole="button"
              accessibilityLabel={`Zoom ${label.replace("×", " times")}`}
              accessibilityState={{ selected: !onUltraWide && Math.abs(zoom - value) < 0.03 }}
            >
              <Text style={[styles.zoomSideLabel, !onUltraWide && Math.abs(zoom - value) < 0.03 && styles.zoomSideLabelActive]}>
                {label}
              </Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={[styles.zoomSideBtn, styles.zoomBadgeBtn]}
            onPress={toggleZoom}
            hitSlop={ZOOM_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={`Zoom ${currentZoomLabel.replace("×", " times")}`}
            accessibilityHint={zoomExpanded ? "Hides zoom levels" : "Shows zoom levels"}
            accessibilityState={{ expanded: zoomExpanded }}
          >
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
              onScrollEndDrag={handleModeScrollEndDrag}
              onMomentumScrollBegin={clearSettleTimer}
              onMomentumScrollEnd={handleModeMomentumEnd}
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
                    accessibilityRole="button"
                    accessibilityLabel={`${MODE_A11Y_LABEL[m.mode]} mode`}
                    accessibilityState={{ selected: isActive, disabled: captureIsActive && !isActive }}
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
              <Ionicons name="cloud-outline" size={26} color={captureIsActive ? "#333" : "white"} accessible={false} />
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
                accessibilityRole="button"
                accessibilityLabel={shutterLabel}
                accessibilityState={{ disabled: panoComposing, busy: panoComposing }}
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
              accessibilityRole="button"
              accessibilityLabel={facing === "back" ? "Switch to front camera" : "Switch to rear camera"}
              accessibilityState={{ disabled: captureIsActive }}
            >
              <Ionicons name="camera-reverse-outline" size={26} color={captureIsActive ? "#333" : "white"} />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Countdown overlay ───────────────────────────────────────────── */}
        {countdown != null && (
          <View style={styles.countdownOverlay} pointerEvents="box-none">
            <Text style={styles.countdownText} pointerEvents="none">{countdown}</Text>
            {/* The shutter also cancels; this makes it obvious. */}
            <TouchableOpacity
              style={styles.countdownCancel}
              onPress={cancelCountdown}
              accessibilityRole="button"
              accessibilityLabel="Cancel self-timer"
            >
              <Ionicons name="close" size={18} color="white" accessible={false} />
              <Text style={styles.countdownCancelText}>Cancel</Text>
            </TouchableOpacity>
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

        {/* ── Scan result modal ───────────────────────────────────────────── */}
        <Modal visible={showScanModal} animationType="slide" onRequestClose={discardScan}>
          <View style={styles.scanModal}>
            <View style={styles.scanModalHeader}>
              <TouchableOpacity
                onPress={discardScan}
                style={styles.scanModalClose}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel="Discard scan"
              >
                <Ionicons name="close" size={24} color="white" />
              </TouchableOpacity>
              <Text style={styles.scanModalTitle} accessibilityRole="header">Document Scan</Text>
              <View style={{ width: 40 }} />
            </View>
            {scanUri && (
              <Image source={{ uri: scanUri }} style={styles.scanPreview} resizeMode="contain" accessibilityLabel="Document scan preview" />
            )}
            <View style={styles.scanModalFooter}>
              <TouchableOpacity style={styles.scanRetakeBtn} onPress={retakeScan} accessibilityRole="button">
                <Ionicons name="camera-outline" size={18} color={PRIMARY} accessible={false} />
                <Text style={styles.scanRetakeText}>Retake</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.scanUploadBtn} onPress={handleUploadScan} accessibilityRole="button">
                <Ionicons name="cloud-upload-outline" size={18} color="white" accessible={false} />
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
            style={{
              position: "absolute", left: -100000, top: 0,
              width: bakeConfig.renderW * bakeConfig.dp, height: bakeConfig.renderH * bakeConfig.dp,
            }}
          >
            <Image
              source={{ uri: bakeConfig.uri }}
              style={{ width: bakeConfig.renderW * bakeConfig.dp, height: bakeConfig.renderH * bakeConfig.dp }}
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
              <View style={{ position: "absolute", left: bakeConfig.pad * bakeConfig.dp, bottom: bakeConfig.pad * bakeConfig.dp }}>
                {bakeConfig.stampLines.map((ln, i) => (
                  <Text
                    key={i}
                    style={{
                      color: PRIMARY,
                      fontSize: bakeConfig.fs * bakeConfig.dp,
                      fontFamily: "Inter_600SemiBold",
                      lineHeight: bakeConfig.fs * bakeConfig.dp * 1.25,
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
              width: panoConfig.outW * panoConfig.dp, height: panoConfig.outH * panoConfig.dp,
              flexDirection: "row", backgroundColor: "#000",
            }}
          >
            {panoConfig.slices.map((sl, i) => {
              const f = panoConfig.frames[sl.frameIndex]!;
              // Each frame contributes one strip: the image is rendered at full
              // width inside a narrower clipping view and shifted so the part
              // of the scene this frame owns lands in the slice.
              return (
                <View
                  key={`${f.uri}-${i}`}
                  style={{ width: sl.sliceW * panoConfig.dp, height: panoConfig.outH * panoConfig.dp, overflow: "hidden" }}
                >
                  <Image
                    source={{ uri: f.uri }}
                    style={{
                      width: panoConfig.frameW * panoConfig.dp,
                      height: panoConfig.frameH * panoConfig.dp,
                      marginLeft: sl.offsetX * panoConfig.dp,
                    }}
                    resizeMode="cover"
                    // Decode at the rendered size (Android/Fresco), keeping the
                    // whole composition inside the panorama memory budget.
                    resizeMethod="resize"
                    fadeDuration={0}
                    onLoad={onPanoFrameLoaded}
                    onError={abandonPanoCompose}
                  />
                </View>
              );
            })}
          </View>
        )}

      </View>
    </GestureDetector>
  );
});

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
    ...StyleSheet.absoluteFill,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  countdownText: {
    color: "white", fontSize: 140, fontFamily: "Inter_700Bold",
    textShadowColor: "rgba(0,0,0,0.6)", textShadowRadius: 18,
  },
  countdownCancel: {
    flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8,
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.6)", borderWidth: 1, borderColor: "rgba(255,255,255,0.3)",
  },
  countdownCancelText: { color: "white", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  subBanner: {
    position: "absolute", left: 14, right: 14,
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.78)", borderWidth: 1, borderColor: "rgba(245,158,11,0.55)",
  },
  subBannerText: { flex: 1, color: "#f59e0b", fontSize: 12, fontFamily: "Inter_600SemiBold" },
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
    ...StyleSheet.absoluteFill,
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
    // like "INTERVAL" never spill past the oval.
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
