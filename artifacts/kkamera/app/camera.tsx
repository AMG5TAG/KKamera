import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
  Animated, Easing, StatusBar, Alert,
} from "react-native";
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

const PRIMARY = "#b19870";

type FlashMode = "off" | "on" | "auto";

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

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const [mode, setMode] = useState<CameraMode>("picture");
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
  const zoomBarOpacity = useRef(new Animated.Value(0)).current;
  const zoomHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerZoomBar = useCallback(() => {
    if (zoomHideTimer.current) clearTimeout(zoomHideTimer.current);
    Animated.timing(zoomBarOpacity, { toValue: 1, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    zoomHideTimer.current = setTimeout(() => {
      Animated.timing(zoomBarOpacity, { toValue: 0, duration: 350, easing: Easing.in(Easing.quad), useNativeDriver: true }).start();
    }, 2500);
  }, [zoomBarOpacity]);

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

  // Request permissions on mount
  useEffect(() => {
    if (!cameraPermission?.granted) requestCameraPermission();
    if (!micPermission?.granted) requestMicPermission();
  }, []);

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
        await executeUpload(photo.uri, fileName, "image", token);
      }
    } catch (err: any) {
      Alert.alert("Capture Failed", err?.message ?? "Could not take photo.");
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, captureScale, settings.imageFormat, executeUpload, token]);

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
          await executeUpload(video.uri, fileName, "video", token);
        }
      }).catch((err: any) => {
        setIsRecording(false);
        if (recordTimer.current) clearInterval(recordTimer.current);
        setRecordSeconds(0);
        if (!String(err?.message).includes("stop")) {
          Alert.alert("Recording Failed", err?.message ?? "Could not record video.");
        }
      });
    } else {
      cameraRef.current?.stopRecording();
    }
  }, [isBusy, isRecording, settings.videoFormat, executeUpload, token]);

  const cycleFlash = () => {
    const cycle: FlashMode[] = ["auto", "on", "off"];
    setFlash(prev => cycle[(cycle.indexOf(prev) + 1) % 3]!);
  };

  const setZoomLevel = (level: number) => {
    setZoom(level);
    triggerZoomBar();
  };

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

  // ─── Permission gates ──────────────────────────────────────────────────────
  if (!cameraPermission) {
    return <View style={styles.container} />;
  }

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

  return (
    <GestureDetector gesture={pinchGesture}>
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* Camera viewfinder */}
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        flash={flash}
        zoom={zoom}
        mode={mode}
      >
        {/* Filter colour overlay */}
        {filterColor && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: filterColor, opacity: 0.22 }]} pointerEvents="none" />
        )}

        {/* Level guide crosshair */}
        {showLevelGuide && (
          <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]} pointerEvents="none">
            <View style={styles.levelLine} />
            <View style={styles.levelDot} />
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

      {/* Upload status */}
      {lastUpload && lastUpload.status !== "idle" && (
        <View style={[styles.uploadStatus, { top: insets.top + (Platform.OS === "web" ? 110 : 70) }]}>
          <Ionicons name={uploadStatusIcon as any} size={16} color={uploadStatusColor} />
          <Text style={[styles.uploadStatusText, { color: uploadStatusColor }]}>{uploadStatusLabel}</Text>
        </View>
      )}

      {/* Zoom controls */}
      <Animated.View
        style={[styles.zoomGlass, { opacity: zoomBarOpacity },
          Platform.OS === "web" ? ({ backdropFilter: "blur(24px) saturate(180%)" } as any) : null,
        ]}
      >
        {([0, 0.25, 0.5, 0.75] as number[]).map((z, i) => {
          const labels = ["·5", "1×", "2×", "5×"];
          return (
            <TouchableOpacity
              key={z}
              style={[styles.zoomPill, zoom === z && styles.zoomPillActive]}
              onPress={() => setZoomLevel(z)}
              activeOpacity={0.75}
            >
              <Text style={[styles.zoomPillText, zoom === z && styles.zoomPillTextActive]}>{labels[i]}</Text>
            </TouchableOpacity>
          );
        })}
      </Animated.View>

      {/* Filter row */}
      {showFilters && (
        <View style={styles.filterRow}>
          {FILTERS.map((f, i) => (
            <TouchableOpacity key={f} style={styles.filterChip} onPress={() => setSelectedFilter(i)}>
              <View style={[styles.filterThumb, {
                backgroundColor: i === 0 ? "#333" : FILTER_COLORS[f] ?? "#888",
                borderWidth: selectedFilter === i ? 2 : 0,
                borderColor: PRIMARY,
              }]} />
              <Text style={[styles.filterLabel, selectedFilter === i && { color: PRIMARY }]}>{f}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Bottom controls */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 16) }]}>
        <View style={[styles.modeGlass,
          Platform.OS === "web" ? ({ backdropFilter: "blur(24px) saturate(180%)" } as any) : null,
        ]}>
          {(["picture", "video"] as CameraMode[]).map(m => (
            <TouchableOpacity
              key={m}
              onPress={() => { if (!isRecording) setMode(m); }}
              style={[styles.modePill, mode === m && styles.modePillActive]}
              activeOpacity={0.75}
            >
              <Text style={[styles.modePillText, mode === m && styles.modePillTextActive]}>
                {m === "picture" ? "PHOTO" : "VIDEO"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.captureRow}>
          <TouchableOpacity style={styles.sideBtn} onPress={() => setShowFilters(v => !v)}>
            <Feather name="sliders" size={22} color={showFilters ? PRIMARY : "white"} />
          </TouchableOpacity>

          <Animated.View style={{ transform: [{ scale: captureScale }] }}>
            <TouchableOpacity
              style={[styles.captureBtn,
                mode === "video" && { borderColor: "#ef4444" },
                isBusy && { opacity: 0.6 },
              ]}
              onPress={mode === "picture" ? handleCapture : handleVideoToggle}
              activeOpacity={0.8}
              disabled={isBusy && !isRecording}
            >
              {mode === "video" ? (
                <View style={[styles.captureInner, isRecording && styles.captureStop]} />
              ) : (
                <View style={styles.captureInner} />
              )}
            </TouchableOpacity>
          </Animated.View>

          <TouchableOpacity
            style={styles.sideBtn}
            onPress={() => setFacing(f => f === "back" ? "front" : "back")}
            disabled={isRecording}
          >
            <Ionicons name="camera-reverse-outline" size={26} color={isRecording ? "#555" : "white"} />
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
  levelDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#b19870" },
  zoomGlass: {
    position: "absolute", bottom: 208, alignSelf: "center",
    flexDirection: "row", alignItems: "center", gap: 2,
    paddingHorizontal: 4, paddingVertical: 4, borderRadius: 50,
    backgroundColor: "rgba(18,14,10,0.52)",
    borderWidth: 1,
    borderTopColor: "rgba(255,255,255,0.28)", borderBottomColor: "rgba(0,0,0,0.35)",
    borderLeftColor: "rgba(255,255,255,0.14)", borderRightColor: "rgba(0,0,0,0.20)",
    shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowRadius: 16, shadowOpacity: 0.45, elevation: 8,
  },
  zoomPill: { paddingHorizontal: 13, paddingVertical: 7, borderRadius: 50, minWidth: 44, alignItems: "center" },
  zoomPillActive: {
    backgroundColor: "rgba(255,255,255,0.93)",
    shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowRadius: 8, shadowOpacity: 0.35, elevation: 5,
  },
  zoomPillText: { color: "rgba(255,255,255,0.65)", fontSize: 13, fontFamily: "Inter_600SemiBold", letterSpacing: 0.3 },
  zoomPillTextActive: { color: "#1a1208", fontFamily: "Inter_700Bold" },
  filterRow: {
    position: "absolute", bottom: 180, left: 0, right: 0,
    flexDirection: "row", paddingHorizontal: 16,
    backgroundColor: "rgba(0,0,0,0.7)", paddingVertical: 10,
  },
  filterChip: { alignItems: "center", marginRight: 14 },
  filterThumb: { width: 44, height: 44, borderRadius: 8, marginBottom: 4 },
  filterLabel: { color: "rgba(255,255,255,0.7)", fontSize: 10, fontFamily: "Inter_400Regular" },
  bottomBar: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    backgroundColor: "rgba(0,0,0,0.75)", paddingTop: 12,
  },
  modeGlass: {
    flexDirection: "row", alignSelf: "center", alignItems: "center", gap: 2, marginBottom: 14,
    paddingHorizontal: 4, paddingVertical: 4, borderRadius: 50,
    backgroundColor: "rgba(18,14,10,0.52)",
    borderWidth: 1,
    borderTopColor: "rgba(255,255,255,0.28)", borderBottomColor: "rgba(0,0,0,0.35)",
    borderLeftColor: "rgba(255,255,255,0.14)", borderRightColor: "rgba(0,0,0,0.20)",
    shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowRadius: 16, shadowOpacity: 0.45, elevation: 8,
  },
  modePill: { paddingHorizontal: 22, paddingVertical: 8, borderRadius: 50, minWidth: 88, alignItems: "center" },
  modePillActive: {
    backgroundColor: "rgba(255,255,255,0.93)",
    shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowRadius: 8, shadowOpacity: 0.3, elevation: 5,
  },
  modePillText: { color: "rgba(255,255,255,0.5)", fontSize: 12, fontFamily: "Inter_700Bold", letterSpacing: 1.8 },
  modePillTextActive: { color: "#1a1208", letterSpacing: 1.8 },
  captureRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 40, marginBottom: 8 },
  sideBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  captureBtn: {
    width: 80, height: 80, borderRadius: 40,
    borderWidth: 4, borderColor: PRIMARY,
    alignItems: "center", justifyContent: "center",
  },
  captureInner: { width: 64, height: 64, borderRadius: 32, backgroundColor: "white" },
  captureStop: { width: 30, height: 30, borderRadius: 6, backgroundColor: "#ef4444" },
  permText: { color: "#aaa", fontFamily: "Inter_400Regular", fontSize: 15, textAlign: "center", paddingHorizontal: 40 },
  permBtn: {
    backgroundColor: PRIMARY, paddingHorizontal: 28, paddingVertical: 13,
    borderRadius: 12, marginTop: 8,
  },
  permBtnText: { color: "white", fontFamily: "Inter_600SemiBold", fontSize: 15 },
  permSkip: { paddingVertical: 8 },
  permSkipText: { color: "#666", fontFamily: "Inter_400Regular", fontSize: 13 },
});
