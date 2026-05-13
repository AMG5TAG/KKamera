import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
  Animated, Easing, StatusBar, Alert,
} from "react-native";
import * as Network from "expo-network";
import * as ImagePicker from "expo-image-picker";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons, Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { CameraView, CameraType, CameraMode, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { useAuth } from "@/contexts/AuthContext";
import { useUpload } from "@/contexts/UploadContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useGetSubscription } from "@workspace/api-client-react";

const PRIMARY = "#b19870";

type FlashMode = "off" | "on" | "auto";
type AppMode = "picture" | "video" | "scan";

const MODES: { mode: AppMode; icon: string; iconActive: string }[] = [
  { mode: "picture", icon: "camera-outline", iconActive: "camera" },
  { mode: "video", icon: "videocam-outline", iconActive: "videocam" },
  { mode: "scan", icon: "document-outline", iconActive: "document-text" },
];

const FILTERS = ["None", "Vivid", "Warm", "Cool", "B&W", "Fade", "Chrome", "Tonal", "Noir", "Silvertone"];

const FILTER_COLORS: Record<string, string | null> = {
  None: null, Vivid: "#ff6b35", Warm: "#f59e0b", Cool: "#60a5fa",
  "B&W": "#888", Fade: "#d4c5b0", Chrome: "#c0c0c0", Tonal: "#8b7355",
  Noir: "#1a1a1a", Silvertone: "#b0b8c0",
};

export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const { lastUpload, executeUpload } = useUpload();
  const { settings } = useSettings();
  const { data: sub, isLoading: subLoading } = useGetSubscription();

  const hasAccess = subLoading
    || sub?.status === "active"
    || (sub?.status === "trial" && sub?.trialEnd != null && new Date(sub.trialEnd) > new Date())
    || sub == null;

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const [appMode, setAppMode] = useState<AppMode>("picture");
  const [facing, setFacing] = useState<CameraType>("back");
  const [flash, setFlash] = useState<FlashMode>("auto");
  const [zoom, setZoom] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [selectedFilter, setSelectedFilter] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [showLevelGuide, setShowLevelGuide] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const cameraRef = useRef<CameraView>(null);
  const captureScale = useRef(new Animated.Value(1)).current;
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const baseZoom = useRef(0);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [zoomExpanded, setZoomExpanded] = useState(false);
  const zoomWidth = useRef(new Animated.Value(0)).current;
  const zoomCollapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ZOOM_COLLAPSED_W = 64;
  const ZOOM_EXPANDED_W = 232;

  const expandZoom = useCallback(() => {
    if (zoomCollapseTimer.current) clearTimeout(zoomCollapseTimer.current);
    setZoomExpanded(true);
    Animated.spring(zoomWidth, { toValue: 1, tension: 90, friction: 11, useNativeDriver: false }).start();
  }, [zoomWidth]);

  const collapseZoom = useCallback(() => {
    if (zoomCollapseTimer.current) clearTimeout(zoomCollapseTimer.current);
    setZoomExpanded(false);
    Animated.spring(zoomWidth, { toValue: 0, tension: 90, friction: 11, useNativeDriver: false }).start();
  }, [zoomWidth]);

  const scheduleCollapse = useCallback((ms = 2800) => {
    if (zoomCollapseTimer.current) clearTimeout(zoomCollapseTimer.current);
    zoomCollapseTimer.current = setTimeout(collapseZoom, ms);
  }, [collapseZoom]);

  const triggerZoomBar = useCallback(() => {
    expandZoom();
    scheduleCollapse();
  }, [expandZoom, scheduleCollapse]);

  const applyZoom = useCallback((scale: number) => {
    const next = Math.min(1, Math.max(0, baseZoom.current + (scale - 1) * 0.5));
    setZoom(next);
    triggerZoomBar();
  }, [triggerZoomBar]);

  const saveBaseZoom = useCallback(() => {
    baseZoom.current = zoom;
  }, [zoom]);

  const pinchGesture = Gesture.Pinch()
    .onStart(() => { runOnJS(saveBaseZoom)(); })
    .onUpdate((e) => { runOnJS(applyZoom)(e.scale); })
    .onEnd(() => { runOnJS(saveBaseZoom)(); });

  useEffect(() => {
    if (!cameraPermission?.granted) requestCameraPermission();
    if (!micPermission?.granted) requestMicPermission();
  }, []);

  const checkWifi = useCallback(async (): Promise<boolean> => {
    if (!settings.uploadOnlyOnWifi) return true;
    try {
      if (Platform.OS === "web") {
        const conn = (navigator as any).connection;
        if (conn?.type && conn.type !== "wifi" && conn.type !== "unknown") return false;
        return true;
      }
      const state = await Network.getNetworkStateAsync();
      return state.type === Network.NetworkStateType.WIFI;
    } catch {
      return true;
    }
  }, [settings.uploadOnlyOnWifi]);

  const confirmUpload = useCallback((): Promise<boolean> => {
    if (!settings.promptBeforeUpload) return Promise.resolve(true);
    return new Promise(resolve => {
      Alert.alert(
        "Upload to Cloud?",
        "Send this file to your connected cloud storage?",
        [
          { text: "Skip", style: "cancel", onPress: () => resolve(false) },
          { text: "Upload", onPress: () => resolve(true) },
        ]
      );
    });
  }, [settings.promptBeforeUpload]);

  const handleCapture = useCallback(async () => {
    if (isBusy) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Animated.sequence([
      Animated.timing(captureScale, { toValue: 0.88, duration: 80, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(captureScale, { toValue: 1, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();
    setIsBusy(true);
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.9 });
      if (photo?.uri) {
        const ext = settings.imageFormat === "heic" ? "heic" : settings.imageFormat === "png" ? "png" : "jpg";
        const fileName = `IMG_${Date.now()}.${ext}`;
        const onWifi = await checkWifi();
        if (!onWifi) { Alert.alert("WiFi Only", "Photo captured but not uploaded — connect to WiFi to upload."); return; }
        const confirmed = await confirmUpload();
        if (confirmed) await executeUpload(photo.uri, fileName, "image", token);
      }
    } catch (err: any) {
      Alert.alert("Capture Failed", err?.message ?? "Could not take photo.");
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, captureScale, settings.imageFormat, executeUpload, token, checkWifi, confirmUpload]);

  const handleVideoToggle = useCallback(async () => {
    if (isBusy) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    if (!isRecording) {
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimer.current = setInterval(() => setRecordSeconds(s => s + 1), 1000);
      cameraRef.current?.recordAsync({ maxDuration: 600 }).then(async (video) => {
        setIsRecording(false);
        if (recordTimer.current) clearInterval(recordTimer.current);
        setRecordSeconds(0);
        if (video?.uri) {
          const fileName = `VID_${Date.now()}.${settings.videoFormat}`;
          const onWifi = await checkWifi();
          if (!onWifi) { Alert.alert("WiFi Only", "Video captured but not uploaded — connect to WiFi to upload."); return; }
          const confirmed = await confirmUpload();
          if (confirmed) await executeUpload(video.uri, fileName, "video", token);
        }
      }).catch((err: any) => {
        setIsRecording(false);
        if (recordTimer.current) clearInterval(recordTimer.current);
        setRecordSeconds(0);
        if (!String(err?.message).includes("stop")) Alert.alert("Recording Failed", err?.message ?? "Could not record video.");
      });
    } else {
      cameraRef.current?.stopRecording();
    }
  }, [isBusy, isRecording, settings.videoFormat, executeUpload, token, checkWifi, confirmUpload]);

  const handleScan = useCallback(async () => {
    if (isBusy) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsBusy(true);
    try {
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        quality: 0.9,
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
      });
      if (!result.canceled && result.assets?.[0]) {
        const uri = result.assets[0].uri;
        const fileName = `SCAN_${Date.now()}.jpg`;
        const onWifi = await checkWifi();
        if (!onWifi) { Alert.alert("WiFi Only", "Scan captured but not uploaded — connect to WiFi to upload."); return; }
        const confirmed = await confirmUpload();
        if (confirmed) await executeUpload(uri, fileName, "image", token);
      }
    } catch (err: any) {
      Alert.alert("Scan Failed", err?.message ?? "Could not scan document.");
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, checkWifi, confirmUpload, executeUpload, token]);

  const handleGalleryImport = useCallback(async () => {
    if (isRecording) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsEditing: false,
        quality: 0.9,
        allowsMultipleSelection: false,
      });
      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        const isVideo = asset.type === "video";
        const ext = isVideo ? settings.videoFormat : "jpg";
        const prefix = isVideo ? "VID" : "IMG";
        const fileName = `${prefix}_IMPORT_${Date.now()}.${ext}`;
        const onWifi = await checkWifi();
        if (!onWifi) { Alert.alert("WiFi Only", "File selected but not uploaded — connect to WiFi to upload."); return; }
        const confirmed = await confirmUpload();
        if (confirmed) {
          setIsBusy(true);
          await executeUpload(asset.uri, fileName, isVideo ? "video" : "image", token);
          setIsBusy(false);
        }
      }
    } catch (err: any) {
      Alert.alert("Import Failed", err?.message ?? "Could not import from gallery.");
    }
  }, [isRecording, settings.videoFormat, checkWifi, confirmUpload, executeUpload, token]);

  const cycleFlash = () => {
    const cycle: FlashMode[] = ["auto", "on", "off"];
    setFlash(prev => cycle[(cycle.indexOf(prev) + 1) % 3]!);
  };

  const setZoomLevel = (level: number) => { setZoom(level); triggerZoomBar(); };
  const flashIcon = flash === "on" ? "flash" : flash === "off" ? "flash-off" : "flash-outline";
  const formatTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const uploadStatusColor = !lastUpload ? "transparent"
    : lastUpload.status === "done" ? "#22c55e"
    : lastUpload.status === "failed" ? "#ef4444"
    : lastUpload.status === "partial" ? "#f59e0b"
    : lastUpload.status === "uploading" ? "#b19870"
    : "#6b7280";

  const uploadStatusIcon = !lastUpload ? "cloud-outline"
    : lastUpload.status === "done" ? "cloud-done-outline"
    : lastUpload.status === "failed" ? "cloud-offline-outline"
    : lastUpload.status === "partial" ? "cloud-outline"
    : "cloud-upload-outline";

  const uploadStatusLabel = !lastUpload ? ""
    : lastUpload.status === "done" ? "Uploaded"
    : lastUpload.status === "failed" ? "Failed"
    : lastUpload.status === "partial" ? "Partial"
    : lastUpload.status === "uploading" ? "Uploading…"
    : lastUpload.status === "queued" ? "Queued"
    : "";

  if (!cameraPermission) return <View style={styles.container} />;

  if (!cameraPermission.granted) {
    return (
      <View style={[styles.container, { alignItems: "center", justifyContent: "center", gap: 16 }]}>
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

  const filterColor = FILTER_COLORS[FILTERS[selectedFilter] ?? "None"];

  if (!hasAccess) {
    return (
      <View style={[styles.container, styles.paywallContainer]}>
        <StatusBar barStyle="light-content" />
        <Ionicons name="lock-closed" size={52} color={PRIMARY} style={{ marginBottom: 20 }} />
        <Text style={styles.paywallTitle}>Subscription Required</Text>
        <Text style={styles.paywallBody}>Your free trial has ended.{"\n"}Subscribe to keep using KKamera.</Text>
        <TouchableOpacity style={styles.paywallBtn} onPress={() => router.push("/settings/subscription")}>
          <Ionicons name="card-outline" size={18} color="white" />
          <Text style={styles.paywallBtnText}>View Subscription — $25/year</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.paywallSecondary} onPress={() => router.push("/settings")}>
          <Text style={styles.paywallSecondaryText}>Go to Settings</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const cameraViewMode: CameraMode = appMode === "scan" ? "picture" : (appMode as CameraMode);

  return (
    <GestureDetector gesture={pinchGesture}>
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        flash={flash}
        zoom={zoom}
        mode={cameraViewMode}
      >
        {filterColor && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: filterColor, opacity: 0.22 }]} pointerEvents="none" />
        )}
        {showLevelGuide && (
          <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]} pointerEvents="none">
            <View style={styles.levelLine} />
            <View style={styles.levelDot} />
          </View>
        )}
        {appMode === "scan" && (
          <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]} pointerEvents="none">
            <View style={styles.scanFrame}>
              <View style={[styles.scanCorner, styles.scanTL]} />
              <View style={[styles.scanCorner, styles.scanTR]} />
              <View style={[styles.scanCorner, styles.scanBL]} />
              <View style={[styles.scanCorner, styles.scanBR]} />
              <Text style={styles.scanHint}>Align document within frame</Text>
            </View>
          </View>
        )}
      </CameraView>

      {/* Top Bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + (Platform.OS === "web" ? 44 : 8) }]}>
        <TouchableOpacity style={styles.iconBtn} onPress={cycleFlash}>
          <Ionicons name={flashIcon as any} size={24} color={flash === "on" ? "#FFD700" : "white"} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={() => setShowLevelGuide(v => !v)}>
          <MaterialCommunityIcons name="spirit-level" size={22} color={showLevelGuide ? PRIMARY : "white"} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={() => setShowFilters(v => !v)}>
          <Feather name="sliders" size={20} color={showFilters ? PRIMARY : "white"} />
        </TouchableOpacity>
        {isRecording && (
          <View style={styles.recordingBadge}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingTime}>{formatTime(recordSeconds)}</Text>
          </View>
        )}
        <TouchableOpacity style={styles.iconBtn} onPress={() => router.push("/settings")}>
          <Ionicons name="settings-outline" size={24} color="white" />
        </TouchableOpacity>
      </View>

      {/* Upload status — tappable, opens history */}
      {lastUpload && lastUpload.status !== "idle" && (
        <TouchableOpacity
          style={[styles.uploadStatus, { top: insets.top + (Platform.OS === "web" ? 110 : 70) }]}
          onPress={() => router.push("/history")}
        >
          <Ionicons name={uploadStatusIcon as any} size={16} color={uploadStatusColor} />
          <Text style={[styles.uploadStatusText, { color: uploadStatusColor }]}>{uploadStatusLabel}</Text>
        </TouchableOpacity>
      )}

      {/* Zoom pill */}
      {(() => {
        const animW = zoomWidth.interpolate({ inputRange: [0, 1], outputRange: [ZOOM_COLLAPSED_W, ZOOM_EXPANDED_W] });
        const pillsOpacity = zoomWidth.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0, 0, 1] });
        const ZOOM_STEPS: { value: number; label: string }[] = [
          { value: 0, label: "·5" }, { value: 0.25, label: "1×" },
          { value: 0.5, label: "2×" }, { value: 0.75, label: "5×" },
        ];
        const currentLabel = ZOOM_STEPS.reduce((prev, cur) =>
          Math.abs(cur.value - zoom) < Math.abs(prev.value - zoom) ? cur : prev
        ).label;
        return (
          <Animated.View style={[styles.zoomGlass, { width: animW, overflow: "hidden" },
            Platform.OS === "web" ? ({ backdropFilter: "blur(24px) saturate(180%)" } as any) : null,
          ]}>
            <TouchableOpacity
              style={[styles.zoomIconBtn, zoomExpanded && styles.zoomIconBtnActive]}
              onPress={() => zoomExpanded ? collapseZoom() : expandZoom()}
              activeOpacity={0.75}
            >
              <MaterialCommunityIcons name="magnify" size={15} color={zoomExpanded ? "#1a1208" : "rgba(255,255,255,0.85)"} />
              {!zoomExpanded && <Text style={styles.zoomCurrentLabel}>{currentLabel}</Text>}
            </TouchableOpacity>
            <Animated.View style={{ flexDirection: "row", opacity: pillsOpacity }}>
              {ZOOM_STEPS.map(({ value: z, label }) => (
                <TouchableOpacity key={z} style={[styles.zoomPill, zoom === z && styles.zoomPillActive]}
                  onPress={() => { setZoomLevel(z); scheduleCollapse(1800); }} activeOpacity={0.75}>
                  <Text style={[styles.zoomPillText, zoom === z && styles.zoomPillTextActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </Animated.View>
          </Animated.View>
        );
      })()}

      {/* Filter row */}
      {showFilters && (
        <View style={styles.filterRow}>
          {FILTERS.map((f, i) => (
            <TouchableOpacity key={f} style={styles.filterChip} onPress={() => setSelectedFilter(i)}>
              <View style={[styles.filterThumb, {
                backgroundColor: i === 0 ? "#333" : FILTER_COLORS[f] ?? "#888",
                borderWidth: selectedFilter === i ? 2 : 0, borderColor: PRIMARY,
              }]} />
              <Text style={[styles.filterLabel, selectedFilter === i && { color: PRIMARY }]}>{f}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Bottom controls */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 16) }]}>
        {/* Mode selector — icons only */}
        <View style={[styles.modeGlass,
          Platform.OS === "web" ? ({ backdropFilter: "blur(24px) saturate(180%)" } as any) : null,
        ]}>
          {MODES.map(({ mode: m, icon, iconActive }) => (
            <TouchableOpacity
              key={m}
              onPress={() => { if (!isRecording) setAppMode(m); }}
              style={[styles.modePill, appMode === m && styles.modePillActive]}
              activeOpacity={0.75}
            >
              <Ionicons
                name={(appMode === m ? iconActive : icon) as any}
                size={20}
                color={appMode === m ? "#1a1208" : "rgba(255,255,255,0.72)"}
              />
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.captureRow}>
          {/* Gallery import */}
          <TouchableOpacity style={styles.sideBtn} onPress={handleGalleryImport} disabled={isRecording}>
            <Ionicons name="images-outline" size={26} color={isRecording ? "#444" : "white"} />
          </TouchableOpacity>

          {/* Capture / Record / Scan button */}
          <Animated.View style={{ transform: [{ scale: captureScale }] }}>
            <TouchableOpacity
              style={[styles.captureBtn,
                appMode === "video" && { borderColor: "#ef4444" },
                appMode === "scan" && { borderColor: PRIMARY },
                isBusy && { opacity: 0.6 },
              ]}
              onPress={
                appMode === "picture" ? handleCapture
                : appMode === "video" ? handleVideoToggle
                : handleScan
              }
              activeOpacity={0.8}
              disabled={isBusy && !isRecording}
            >
              {appMode === "video" ? (
                <View style={[styles.captureInner, isRecording && styles.captureStop]} />
              ) : appMode === "scan" ? (
                <Ionicons name="document-text" size={26} color={PRIMARY} />
              ) : (
                <View style={styles.captureInner} />
              )}
            </TouchableOpacity>
          </Animated.View>

          {/* Flip camera */}
          <TouchableOpacity
            style={styles.sideBtn}
            onPress={() => setFacing(f => f === "back" ? "front" : "back")}
            disabled={isRecording}
          >
            <Ionicons name="camera-reverse-outline" size={26} color={isRecording ? "#444" : "white"} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  topBar: {
    position: "absolute", top: 0, left: 0, right: 0,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingBottom: 12,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  iconBtn: { padding: 8, borderRadius: 20 },
  recordingBadge: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "rgba(0,0,0,0.5)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
  },
  recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#ef4444" },
  recordingTime: { color: "white", fontSize: 13, fontFamily: "Inter_500Medium" },
  uploadStatus: {
    position: "absolute", right: 16,
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 14, borderWidth: 1, borderColor: "rgba(177,152,112,0.3)",
  },
  uploadStatusText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  levelLine: { width: "60%", height: 1, backgroundColor: "rgba(177,152,112,0.6)", position: "absolute" },
  levelDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: PRIMARY },
  scanFrame: {
    width: "76%", height: "52%", position: "relative",
    alignItems: "center", justifyContent: "flex-end", paddingBottom: 12,
  },
  scanCorner: { position: "absolute", width: 28, height: 28, borderColor: PRIMARY, borderWidth: 3 },
  scanTL: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 6 },
  scanTR: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 6 },
  scanBL: { bottom: 24, left: 0, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 6 },
  scanBR: { bottom: 24, right: 0, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 6 },
  scanHint: { color: "rgba(177,152,112,0.9)", fontSize: 12, fontFamily: "Inter_500Medium", textAlign: "center" },
  zoomGlass: {
    position: "absolute", bottom: 212, alignSelf: "center",
    flexDirection: "row", alignItems: "center", gap: 2,
    paddingHorizontal: 4, paddingVertical: 4, borderRadius: 50,
    backgroundColor: "rgba(18,14,10,0.52)",
    borderWidth: 1,
    borderTopColor: "rgba(255,255,255,0.28)", borderBottomColor: "rgba(0,0,0,0.35)",
    borderLeftColor: "rgba(255,255,255,0.14)", borderRightColor: "rgba(0,0,0,0.20)",
    shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowRadius: 16, shadowOpacity: 0.45, elevation: 8,
  },
  zoomIconBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 50, minWidth: 52 },
  zoomIconBtnActive: { backgroundColor: "rgba(255,255,255,0.93)", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowRadius: 8, shadowOpacity: 0.3, elevation: 5 },
  zoomCurrentLabel: { color: "rgba(255,255,255,0.75)", fontSize: 12, fontFamily: "Inter_600SemiBold", letterSpacing: 0.3 },
  zoomPill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 50, minWidth: 42, alignItems: "center" },
  zoomPillActive: { backgroundColor: "rgba(255,255,255,0.93)", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowRadius: 8, shadowOpacity: 0.35, elevation: 5 },
  zoomPillText: { color: "rgba(255,255,255,0.65)", fontSize: 13, fontFamily: "Inter_600SemiBold", letterSpacing: 0.3 },
  zoomPillTextActive: { color: "#1a1208", fontFamily: "Inter_700Bold" },
  filterRow: {
    position: "absolute", bottom: 184, left: 0, right: 0,
    flexDirection: "row", paddingHorizontal: 16,
    backgroundColor: "rgba(0,0,0,0.7)", paddingVertical: 10,
  },
  filterChip: { alignItems: "center", marginRight: 14 },
  filterThumb: { width: 44, height: 44, borderRadius: 8, marginBottom: 4 },
  filterLabel: { color: "rgba(255,255,255,0.7)", fontSize: 10, fontFamily: "Inter_400Regular" },
  bottomBar: { position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.75)", paddingTop: 12 },
  modeGlass: {
    flexDirection: "row", alignSelf: "center", alignItems: "center", gap: 2, marginBottom: 14,
    paddingHorizontal: 4, paddingVertical: 4, borderRadius: 50,
    backgroundColor: "rgba(18,14,10,0.52)",
    borderWidth: 1,
    borderTopColor: "rgba(255,255,255,0.28)", borderBottomColor: "rgba(0,0,0,0.35)",
    borderLeftColor: "rgba(255,255,255,0.14)", borderRightColor: "rgba(0,0,0,0.20)",
    shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowRadius: 16, shadowOpacity: 0.45, elevation: 8,
  },
  modePill: { padding: 14, borderRadius: 50, alignItems: "center", justifyContent: "center" },
  modePillActive: {
    backgroundColor: "rgba(255,255,255,0.93)",
    shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowRadius: 8, shadowOpacity: 0.35, elevation: 5,
  },
  captureRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 48, marginBottom: 8 },
  sideBtn: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  captureBtn: {
    width: 76, height: 76, borderRadius: 38,
    borderWidth: 4, borderColor: "white",
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  captureInner: { width: 54, height: 54, borderRadius: 27, backgroundColor: "white" },
  captureStop: { width: 28, height: 28, borderRadius: 5, backgroundColor: "#ef4444" },
  permText: { fontSize: 16, color: "white", fontFamily: "Inter_400Regular", textAlign: "center", paddingHorizontal: 32 },
  permBtn: { backgroundColor: PRIMARY, paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14 },
  permBtnText: { color: "white", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  permSkip: { paddingVertical: 8 },
  permSkipText: { color: "#888", fontSize: 13, fontFamily: "Inter_400Regular" },
  paywallContainer: { alignItems: "center", justifyContent: "center", padding: 32 },
  paywallTitle: { fontSize: 26, fontFamily: "Inter_700Bold", color: "white", marginBottom: 12, textAlign: "center" },
  paywallBody: { fontSize: 15, color: "#aaa", fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 22, marginBottom: 32 },
  paywallBtn: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: PRIMARY, paddingHorizontal: 28, paddingVertical: 16, borderRadius: 16, marginBottom: 14,
  },
  paywallBtnText: { color: "white", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  paywallSecondary: { paddingVertical: 8 },
  paywallSecondaryText: { color: "#888", fontSize: 14, fontFamily: "Inter_400Regular" },
});
