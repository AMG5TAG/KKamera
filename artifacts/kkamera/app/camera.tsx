import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
  Animated, Easing, StatusBar, Alert, ScrollView, Modal, Image,
  useWindowDimensions,
} from "react-native";
import * as Network from "expo-network";
import * as ImagePicker from "expo-image-picker";
import * as Speech from "expo-speech";
import * as Location from "expo-location";
import * as FileSystem from "expo-file-system";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons, Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { CameraView, CameraType, CameraMode, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { useAuth } from "@/contexts/AuthContext";
import { useUpload } from "@/contexts/UploadContext";
import { useSettings, type GridType } from "@/contexts/SettingsContext";
import { useGetSubscription } from "@workspace/api-client-react";
import Svg, { Line, Rect, G } from "react-native-svg";
import { TrialBanner } from "@/components/TrialBanner";
import { WebCamera } from "@/components/WebCamera";
import { processDocumentScan } from "@/lib/documentScan";
import { API_BASE_URL } from "@/lib/config";

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
async function getMagnetometer() {
  if (Platform.OS === "web") return null;
  const { Magnetometer } = await import("expo-sensors");
  return Magnetometer;
}

type FlashMode = "off" | "on" | "auto";
type ExtMode = "photo" | "portrait" | "cinematic" | "video" | "slow-mo" | "timelapse" | "pano" | "scan" | "spatial";

interface ModeConfig { mode: ExtMode; label: string; cameraMode: CameraMode; isVideo: boolean }

const EXT_MODES: ModeConfig[] = [
  { mode: "photo",     label: "PHOTO",      cameraMode: "picture", isVideo: false },
  { mode: "portrait",  label: "PORTRAIT",   cameraMode: "picture", isVideo: false },
  { mode: "cinematic", label: "CINEMATIC",  cameraMode: "video",   isVideo: true  },
  { mode: "video",     label: "VIDEO",      cameraMode: "video",   isVideo: true  },
  { mode: "slow-mo",   label: "SLO-MO",     cameraMode: "video",   isVideo: true  },
  { mode: "timelapse", label: "TIME-LAPSE", cameraMode: "picture", isVideo: false },
  { mode: "pano",      label: "PANO",       cameraMode: "picture", isVideo: false },
  { mode: "scan",      label: "SCAN",       cameraMode: "picture", isVideo: false },
  { mode: "spatial",   label: "SPATIAL",    cameraMode: "video",   isVideo: true  },
];

const FILTERS = [
  { name: "None",       color: null,        isBeauty: false },
  { name: "Vivid",      color: "#ff6b35",   isBeauty: false },
  { name: "Warm",       color: "#f59e0b",   isBeauty: false },
  { name: "Cool",       color: "#60a5fa",   isBeauty: false },
  { name: "B&W",        color: "#888",      isBeauty: false },
  { name: "Fade",       color: "#d4c5b0",   isBeauty: false },
  { name: "Noir",       color: "#1a1a1a",   isBeauty: false },
  { name: "Beauty",     color: "#ffb7c5",   isBeauty: true  },
  { name: "Smooth",     color: "#f0e6d3",   isBeauty: true  },
  { name: "Glow",       color: "#fff9c4",   isBeauty: true  },
  { name: "Porcelain",  color: "#dfe8f0",   isBeauty: true  },
];

const ZOOM_LEVELS = [
  { value: 0,    label: "·5" },
  { value: 0.25, label: "1×" },
  { value: 0.5,  label: "2×" },
  { value: 0.75, label: "5×" },
  { value: 1,    label: "10×" },
];

// iOS Camera-style ordered strip: 3 left · VIDEO · PHOTO · DOC · 3 right
const STRIP_MODES: ModeConfig[] = [
  EXT_MODES.find(m => m.mode === "pano")!,
  EXT_MODES.find(m => m.mode === "portrait")!,
  EXT_MODES.find(m => m.mode === "cinematic")!,
  EXT_MODES.find(m => m.mode === "video")!,
  EXT_MODES.find(m => m.mode === "photo")!,
  EXT_MODES.find(m => m.mode === "scan")!,
  EXT_MODES.find(m => m.mode === "slow-mo")!,
  EXT_MODES.find(m => m.mode === "timelapse")!,
  EXT_MODES.find(m => m.mode === "spatial")!,
];
const STRIP_LABEL: Partial<Record<ExtMode, string>> = {
  scan: "DOC", "slow-mo": "SLO-MO", timelapse: "TIME-LAPSE",
};
const DEFAULT_STRIP_IDX = STRIP_MODES.findIndex(m => m.mode === "photo"); // 4
const ITEM_W = 88;

export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const { width: screenW } = useWindowDimensions();
  const { token } = useAuth();
  const { lastUpload, executeUpload } = useUpload();
  const { settings, updateSetting } = useSettings();
  const { data: sub, isLoading: subLoading } = useGetSubscription();
  const [showWebCamera, setShowWebCamera] = useState(false);

  // Gate the camera UI on a real entitlement. While the subscription is still
  // loading we optimistically allow it (the server enforces /uploads/execute
  // regardless), but we do NOT grant access just because `sub` is missing —
  // past_due is allowed to match the server's grace behaviour.
  const hasAccess = subLoading
    || sub?.status === "active"
    || sub?.status === "past_due"
    || (sub?.status === "trial" && sub?.trialEnd != null && new Date(sub.trialEnd) > new Date());

  const trialDaysLeft = sub?.status === "trial" && sub?.trialEnd
    ? Math.max(0, Math.ceil((new Date(sub.trialEnd).getTime() - Date.now()) / 86400000))
    : null;

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const [extMode, setExtMode] = useState<ExtMode>("photo");
  const [facing, setFacing] = useState<CameraType>("back");
  const [flash, setFlash] = useState<FlashMode>("auto");
  const [zoom, setZoom] = useState(0.25);
  const [isRecording, setIsRecording] = useState(false);
  const [selectedFilter, setSelectedFilter] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  // Time-lapse state
  const [isTimelapsing, setIsTimelapsing] = useState(false);
  const [tlCount, setTlCount] = useState(0);
  const tlTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tlPhotos = useRef<string[]>([]);

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

  // Zoom collapse
  const [zoomExpanded, setZoomExpanded] = useState(false);
  const zoomCollapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pro-camera state
  const [countdown, setCountdown] = useState<number | null>(null);
  const [screenFlashing, setScreenFlashing] = useState(false);
  const [heading, setHeading] = useState<number | null>(null);
  const [stampToast, setStampToast] = useState<string | null>(null);

  const cameraRef = useRef<CameraView>(null);
  const captureScale = useRef(new Animated.Value(1)).current;
  const screenFlashOpacity = useRef(new Animated.Value(0)).current;
  const baseZoom = useRef(0.25);

  useEffect(() => {
    if (!cameraPermission?.granted) requestCameraPermission();
    if (!micPermission?.granted) requestMicPermission();
  }, []);

  // Magnetometer subscription for compass bearing (GPSImgDirection)
  useEffect(() => {
    if (!settings.compassMeta || Platform.OS === "web") { setHeading(null); return; }
    let sub: { remove: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const Magnetometer = await getMagnetometer();
        if (!Magnetometer || cancelled) return;
        const available = await Magnetometer.isAvailableAsync();
        if (cancelled || !available) return;
        Magnetometer.setUpdateInterval(500);
        const created = Magnetometer.addListener(({ x, y }) => {
          let deg = Math.atan2(y, x) * (180 / Math.PI);
          if (deg < 0) deg += 360;
          setHeading(Math.round(deg));
        });
        if (cancelled) created.remove();
        else sub = created;
      } catch { /* sensor unavailable */ }
    })();
    return () => { cancelled = true; sub?.remove(); };
  }, [settings.compassMeta]);

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

  // Scroll strip to the currently active mode
  useEffect(() => {
    const idx = STRIP_MODES.findIndex(m => m.mode === extMode);
    if (idx >= 0) {
      const t = setTimeout(() => {
        modeScrollRef.current?.scrollTo({ x: idx * ITEM_W, animated: true });
      }, 60);
      return () => clearTimeout(t);
    }
  }, [extMode]);

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

  const checkWifi = useCallback(async (): Promise<boolean> => {
    if (!settings.uploadOnlyOnWifi) return true;
    try {
      if (Platform.OS === "web") return true;
      const state = await Network.getNetworkStateAsync();
      return state.type === Network.NetworkStateType.WIFI;
    } catch { return true; }
  }, [settings.uploadOnlyOnWifi]);

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

  const doUpload = useCallback(async (uri: string, fileName: string, type: "image" | "video") => {
    const onWifi = await checkWifi();
    if (!onWifi) { Alert.alert("WiFi Only", "File captured but not uploaded — connect to WiFi."); return; }
    const confirmed = await confirmUpload();
    if (!confirmed) return;

    const onDeleteLocal = settings.deleteLocalAfterUpload && Platform.OS !== "web"
      ? async () => { await FileSystem.deleteAsync(uri, { idempotent: true }); }
      : undefined;

    if (type === "image" && settings.photoMarkup) {
      router.push({ pathname: "/markup", params: { uri, fileName } });
    } else {
      await executeUpload(uri, fileName, type, token, undefined, onDeleteLocal);
      notifyWitness(fileName);
    }
  }, [checkWifi, confirmUpload, settings.photoMarkup, settings.deleteLocalAfterUpload, executeUpload, token, notifyWitness]);

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

  // Brief screen flash for selfies (web/PWA — white overlay)
  const doScreenFlash = useCallback(async () => {
    if (!settings.screenFlashSelfie || facing !== "front") return;
    setScreenFlashing(true);
    screenFlashOpacity.setValue(0);
    await new Promise<void>(resolve => {
      Animated.sequence([
        Animated.timing(screenFlashOpacity, { toValue: 1, duration: 90, useNativeDriver: true }),
        Animated.timing(screenFlashOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start(() => { setScreenFlashing(false); resolve(); });
    });
  }, [settings.screenFlashSelfie, facing, screenFlashOpacity]);

  // Stamp date / time / location onto an image (web canvas only — PWA target)
  const stampImageWeb = useCallback(async (dataUri: string): Promise<string> => {
    if (Platform.OS !== "web") return dataUri;
    try {
      const now = new Date();
      const lines: string[] = [now.toLocaleString()];
      if (settings.saveLocation) {
        try {
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          lines.push(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`);
        } catch { /* no location */ }
      }
      if (heading != null) lines.push(`Bearing ${heading}°`);
      const img: HTMLImageElement = await new Promise((res, rej) => {
        const i = new (window as any).Image();
        i.onload = () => res(i); i.onerror = rej; i.src = dataUri;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const pad = Math.round(canvas.width * 0.025);
      const fs = Math.round(canvas.width * 0.028);
      ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = "bottom";
      ctx.shadowColor = "rgba(0,0,0,0.85)"; ctx.shadowBlur = 6;
      ctx.fillStyle = "#b19870";
      lines.forEach((ln, idx) => {
        const y = canvas.height - pad - (lines.length - 1 - idx) * (fs * 1.25);
        ctx.fillText(ln, pad, y);
      });
      const mime = settings.imageFormat === "png" ? "image/png" : settings.imageFormat === "webp" ? "image/webp" : "image/jpeg";
      return canvas.toDataURL(mime, 0.92);
    } catch { return dataUri; }
  }, [settings.saveLocation, settings.imageFormat, heading]);

  // Single capture cycle (screen flash → snap → stamp/strip → upload).
  // The self-timer runs once at the start of a burst, not on every shot.
  const captureOne = useCallback(async (indexLabel?: string) => {
    await doScreenFlash();
    pulseCaptureBtn();
    if (Platform.OS !== "web") {
      try { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch { /* */ }
    }
    const photo = await cameraRef.current?.takePictureAsync({
      quality: 0.9,
      exif: !settings.stripExif,
    });
    if (!photo?.uri) return;
    let uri = photo.uri;
    let toastMsg: string | null = null;
    if (settings.stampPhotos) {
      uri = await stampImageWeb(uri);
      toastMsg = Platform.OS === "web"
        ? "Stamped: date · time" + (settings.saveLocation ? " · location" : "") + (heading != null ? " · bearing" : "")
        : "Stamp metadata recorded";
    }
    if (toastMsg) {
      setStampToast(toastMsg);
      setTimeout(() => setStampToast(null), 1800);
    }
    const ext = settings.imageFormat === "heic" ? "heic" : settings.imageFormat === "png" ? "png" : settings.imageFormat === "webp" ? "webp" : "jpg";
    const prefix = extMode === "portrait" ? "PORT" : extMode === "pano" ? "PANO" : "IMG";
    const suffix = indexLabel ? `_${indexLabel}` : "";
    const fileName = `${prefix}_${Date.now()}${suffix}.${ext}`;
    await doUpload(uri, fileName, "image");
  }, [settings.timerSeconds, settings.stripExif, settings.stampPhotos, settings.imageFormat, settings.saveLocation, runCountdown, doScreenFlash, stampImageWeb, extMode, doUpload, heading]);

  const handlePhotoCapture = useCallback(async () => {
    if (isBusy) return;
    setIsBusy(true);
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
    } finally { setIsBusy(false); }
  }, [isBusy, settings.burstCount, settings.burstDelay, settings.timerSeconds, runCountdown, captureOne]);

  // Keep the keyboard-shutter ref pointed at the latest handler
  useEffect(() => { handleCaptureRef.current = () => { handlePhotoCapture(); }; }, [handlePhotoCapture]);

  const handleVideoToggle = useCallback(async () => {
    if (isBusy && !isRecording) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    if (!isRecording) {
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimer.current = setInterval(() => setRecordSeconds(s => s + 1), 1000);
      const maxDuration = settings.maxVideoDurationSeconds > 0 ? settings.maxVideoDurationSeconds : 600;
      cameraRef.current?.recordAsync({ maxDuration }).then(async (video) => {
        setIsRecording(false);
        if (recordTimer.current) clearInterval(recordTimer.current);
        setRecordSeconds(0);
        if (video?.uri) {
          const prefix = extMode === "cinematic" ? "CIN" : extMode === "slow-mo" ? "SLO" : extMode === "spatial" ? "SPA" : "VID";
          const fileName = `${prefix}_${Date.now()}.${settings.videoFormat}`;
          await doUpload(video.uri, fileName, "video");
        }
      }).catch((err: any) => {
        setIsRecording(false);
        if (recordTimer.current) clearInterval(recordTimer.current);
        setRecordSeconds(0);
        if (!String(err?.message).includes("stop"))
          Alert.alert("Recording Failed", err?.message ?? "Could not record video.");
      });
    } else {
      cameraRef.current?.stopRecording();
    }
  }, [isBusy, isRecording, settings.videoFormat, extMode, doUpload]);

  const handleScan = useCallback(async () => {
    if (isBusy) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    pulseCaptureBtn();
    setIsBusy(true);
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.95 });
      if (photo?.uri) {
        // Auto-crop, deskew and enhance on web; native keeps the raw capture
        let uri = photo.uri;
        let cropped = false;
        if (Platform.OS === "web") {
          setIsProcessingScan(true);
          try {
            const result = await processDocumentScan(photo.uri);
            uri = result.uri;
            cropped = result.cropped;
          } finally { setIsProcessingScan(false); }
        }
        const fileName = `SCAN_${Date.now()}.jpg`;
        setScanUri(uri);
        setScanCropped(cropped);
        setScanFileName(fileName);
        setShowScanModal(true);
      }
    } catch (err: any) {
      Alert.alert("Scan Failed", err?.message ?? "Could not capture document.");
    } finally { setIsBusy(false); }
  }, [isBusy]);

  const handleUploadScan = useCallback(async () => {
    setShowScanModal(false);
    if (!scanUri || !scanFileName) return;
    await doUpload(scanUri, scanFileName, "image");
    setScanUri(null);
  }, [scanUri, scanFileName, doUpload]);

  const handleTimelapse = useCallback(async () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    if (!isTimelapsing) {
      setIsTimelapsing(true);
      setTlCount(0);
      tlPhotos.current = [];
      tlTimer.current = setInterval(async () => {
        try {
          const photo = await cameraRef.current?.takePictureAsync({ quality: 0.7, skipProcessing: true });
          if (photo?.uri) {
            tlPhotos.current.push(photo.uri);
            setTlCount(c => c + 1);
          }
        } catch { /* silently continue */ }
      }, 2000);
    } else {
      if (tlTimer.current) clearInterval(tlTimer.current);
      setIsTimelapsing(false);
      const photos = [...tlPhotos.current];
      tlPhotos.current = [];
      setTlCount(0);
      if (photos.length === 0) return;
      const onWifi = await checkWifi();
      if (!onWifi) { Alert.alert("WiFi Only", `${photos.length} frames captured but not uploaded.`); return; }
      Alert.alert("Upload Time-lapse?", `Upload ${photos.length} frames?`, [
        { text: "Discard", style: "destructive" },
        {
          text: `Upload ${photos.length} frames`, onPress: async () => {
            for (let i = 0; i < photos.length; i++) {
              await executeUpload(photos[i]!, `TL_${Date.now()}_${i}.jpg`, "image", token);
            }
          },
        },
      ]);
    }
  }, [isTimelapsing, checkWifi, executeUpload, token]);

  const handleGalleryImport = useCallback(async () => {
    if (isRecording || isTimelapsing) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsEditing: false, quality: 0.9, allowsMultipleSelection: false,
      });
      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        const isVideo = asset.type === "video";
        const fileName = `${isVideo ? "VID" : "IMG"}_IMPORT_${Date.now()}.${isVideo ? settings.videoFormat : "jpg"}`;
        await doUpload(asset.uri, fileName, isVideo ? "video" : "image");
      }
    } catch (err: any) {
      Alert.alert("Import Failed", err?.message ?? "Could not import.");
    }
  }, [isRecording, isTimelapsing, settings.videoFormat, doUpload]);

  const handleCapture = () => {
    const m = extMode;
    if (m === "scan") return handleScan();
    if (m === "timelapse") return handleTimelapse();
    if (currentModeConfig.isVideo) return handleVideoToggle();
    return handlePhotoCapture();
  };

  const scrollToMode = useCallback((idx: number) => {
    try {
      modeScrollRef.current?.scrollTo({ x: idx * ITEM_W, animated: true });
    } catch { /* ignore */ }
  }, []);

  const cycleFlash = () => {
    const cycle: FlashMode[] = ["auto", "on", "off"];
    setFlash(prev => cycle[(cycle.indexOf(prev) + 1) % 3]!);
  };

  const currentZoomLabel = zoom < 0.1 ? "·5" : zoom < 0.4 ? "1×" : zoom < 0.6 ? "2×" : zoom < 0.85 ? "5×" : "10×";

  const toggleZoom = useCallback(() => {
    if (zoomCollapseTimer.current) clearTimeout(zoomCollapseTimer.current);
    setZoomExpanded(prev => {
      if (!prev) {
        zoomCollapseTimer.current = setTimeout(() => setZoomExpanded(false), 3000);
      }
      return !prev;
    });
  }, []);

  const selectZoom = useCallback((value: number) => {
    setZoom(value);
    if (zoomCollapseTimer.current) clearTimeout(zoomCollapseTimer.current);
    zoomCollapseTimer.current = setTimeout(() => setZoomExpanded(false), 2000);
  }, []);

  const flashIcon = flash === "on" ? "flash" : flash === "off" ? "flash-off" : "flash-outline";
  const formatTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

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

  const filterColor = FILTERS[selectedFilter]?.color ?? null;

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
          <Text style={styles.paywallBtnText}>View Subscription — $25/year</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isVideoMode = currentModeConfig.isVideo && extMode !== "timelapse";
  const captureIsActive = isRecording || isTimelapsing;

  const handleModeScrollEnd = (e: any) => {
    const x = e?.nativeEvent?.contentOffset?.x ?? 0;
    const idx = Math.round(x / ITEM_W);
    const clamped = Math.max(0, Math.min(idx, STRIP_MODES.length - 1));
    if (!captureIsActive) setExtMode(STRIP_MODES[clamped]!.mode);
  };

  // Web camera overlay (PWA capture using getUserMedia)
  if (Platform.OS === "web" && showWebCamera) {
    return (
      <WebCamera
        onCapture={async (uri, fileName, type) => {
          setShowWebCamera(false);
          await doUpload(uri, fileName, type);
        }}
        onClose={() => setShowWebCamera(false)}
      />
    );
  }

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
          ]}
          facing={facing}
          flash={flash}
          zoom={zoom}
          mode={cameraViewMode}
        >
          {/* Colour filter overlay */}
          {filterColor && (
            <View
              style={[StyleSheet.absoluteFill, {
                backgroundColor: filterColor,
                opacity: FILTERS[selectedFilter]?.isBeauty ? 0.14 : 0.22,
              }]}
              pointerEvents="none"
            />
          )}

          {/* Level guide */}
          {settings.showLevelGuide && (
            <View style={[StyleSheet.absoluteFill, styles.levelContainer]} pointerEvents="none">
              <View style={styles.levelLine} />
              <View style={styles.levelDot} />
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

          {/* Portrait overlay */}
          {extMode === "portrait" && (
            <View style={[StyleSheet.absoluteFill, styles.overlayCenter]} pointerEvents="none">
              <View style={styles.portraitOval} />
              <Text style={styles.modeHint}>Portrait Mode — subject in centre</Text>
            </View>
          )}

          {/* Pano guide */}
          {extMode === "pano" && (
            <View style={[StyleSheet.absoluteFill, styles.overlayCenter]} pointerEvents="none">
              <View style={styles.panoLine} />
              <Text style={styles.modeHint}>Pan slowly left to right</Text>
            </View>
          )}

          {/* Time-lapse counter */}
          {isTimelapsing && (
            <View style={[styles.tlCounter]} pointerEvents="none">
              <Ionicons name="timer-outline" size={16} color={PRIMARY} />
              <Text style={styles.tlCountText}>{tlCount} frames</Text>
            </View>
          )}
        </CameraView>

        {/* ── Top Bar ─────────────────────────────────────────────────────── */}
        <View style={[styles.topBar, { paddingTop: insets.top + (Platform.OS === "web" ? 44 : 8) }]}>
          <TouchableOpacity style={styles.iconBtn} onPress={cycleFlash}>
            <Ionicons name={flashIcon as any} size={24} color={flash === "on" ? "#FFD700" : "white"} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => updateSetting("showLevelGuide", !settings.showLevelGuide)}>
            <MaterialCommunityIcons name="spirit-level" size={22} color={settings.showLevelGuide ? PRIMARY : "white"} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => {
            const next = settings.gridType === "off" ? "thirds" : settings.gridType === "thirds" ? "golden" : settings.gridType === "golden" ? "square" : settings.gridType === "square" ? "diagonal" : "off";
            updateSetting("gridType", next);
          }}>
            <Ionicons name="grid-outline" size={20} color={settings.gridType !== "off" ? PRIMARY : "white"} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => {
            const next = settings.timerSeconds === 0 ? 3 : settings.timerSeconds === 3 ? 10 : 0;
            updateSetting("timerSeconds", next);
          }}>
            <Ionicons name="timer-outline" size={22} color={settings.timerSeconds > 0 ? PRIMARY : "white"} />
            {settings.timerSeconds > 0 && (
              <Text style={styles.timerBadge}>{settings.timerSeconds}s</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setShowFilters(v => !v)}>
            <Feather name="sliders" size={20} color={showFilters ? PRIMARY : "white"} />
          </TouchableOpacity>
          {(isRecording) && (
            <View style={styles.recordingBadge}>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingTime}>{formatTime(recordSeconds)}</Text>
            </View>
          )}
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.push("/settings")}>
            <Ionicons name="settings-outline" size={24} color="white" />
          </TouchableOpacity>
        </View>

        {/* ── Upload status badge ─────────────────────────────────────────── */}
        {lastUpload && uploadStatusLabel !== "" && settings.recordHistory && (
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
                    backgroundColor: f.color ?? "#2a2a2a",
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
          {zoomExpanded && ZOOM_LEVELS.map(({ value, label }) => (
            <TouchableOpacity key={value} style={styles.zoomSideBtn} onPress={() => selectZoom(value)}>
              <Text style={[styles.zoomSideLabel, Math.abs(zoom - value) < 0.05 && styles.zoomSideLabelActive]}>
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
              contentOffset={{ x: DEFAULT_STRIP_IDX * ITEM_W, y: 0 }}
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
                    <Text style={[styles.stripLabel, isActive && styles.stripLabelActive]}>{lbl}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {/* Capture row */}
          <View style={styles.captureRow}>
            {/* Gallery import / Web camera */}
            {Platform.OS === "web" ? (
              <TouchableOpacity style={styles.sideBtn} onPress={() => setShowWebCamera(true)} disabled={captureIsActive}>
                <Ionicons name="videocam-outline" size={26} color={captureIsActive ? "#333" : PRIMARY} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.sideBtn} onPress={handleGalleryImport} disabled={captureIsActive}>
                <Ionicons name="images-outline" size={26} color={captureIsActive ? "#333" : "white"} />
              </TouchableOpacity>
            )}

            {/* Capture button */}
            <Animated.View style={{ transform: [{ scale: captureScale }] }}>
              <TouchableOpacity
                style={[
                  styles.captureBtn,
                  isVideoMode && { borderColor: "#ef4444" },
                  extMode === "scan" && { borderColor: PRIMARY },
                  extMode === "timelapse" && { borderColor: "#f59e0b" },
                ]}
                onPress={handleCapture}
                activeOpacity={0.8}
              >
                {extMode === "timelapse" ? (
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
                // Front camera starts at 0.5× (zoom 0); rear resumes at the 1× default
                const z = next === "front" ? 0 : 0.25;
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
        <Modal visible={showScanModal} animationType="slide" onRequestClose={() => setShowScanModal(false)}>
          <View style={styles.scanModal}>
            <View style={styles.scanModalHeader}>
              <TouchableOpacity onPress={() => { setShowScanModal(false); setScanUri(null); }} style={styles.scanModalClose}>
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
              <TouchableOpacity style={styles.scanRetakeBtn} onPress={() => { setShowScanModal(false); setScanUri(null); }}>
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
    paddingHorizontal: 18, paddingBottom: 12,
    backgroundColor: "rgba(0,0,0,0.38)",
  },
  iconBtn: { padding: 8, borderRadius: 20 },
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
  levelLine: { width: "60%", height: 1, backgroundColor: "rgba(177,152,112,0.6)", position: "absolute" },
  levelDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: PRIMARY },
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
  portraitOval: {
    width: 180, height: 240, borderRadius: 90,
    borderWidth: 2, borderColor: "rgba(177,152,112,0.7)", borderStyle: "dashed",
  },
  panoLine: { width: "80%", height: 1, backgroundColor: "rgba(177,152,112,0.8)" },
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
  },
  stripLabelActive: {
    color: "white",
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1,
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
