import React, { useState, useRef, useCallback } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
  Animated, Easing, useColorScheme, StatusBar,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons, Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useAuth } from "@/contexts/AuthContext";
import { useUpload } from "@/contexts/UploadContext";
import { useSettings } from "@/contexts/SettingsContext";

const PRIMARY = "#b19870";
const SECONDARY = "#c3b091";

type CameraMode = "photo" | "video";
type FlashMode = "off" | "on" | "auto";

const FILTERS = ["None", "Vivid", "Warm", "Cool", "B&W", "Fade", "Chrome", "Tonal", "Noir", "Silvertone"];

export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const { lastUpload, addUpload, updateUpload } = useUpload();
  const { settings, updateSetting } = useSettings();

  const [mode, setMode] = useState<CameraMode>("photo");
  const [facing, setFacing] = useState<"front" | "back">("back");
  const [flash, setFlash] = useState<FlashMode>("auto");
  const [zoom, setZoom] = useState(1);
  const [isRecording, setIsRecording] = useState(false);
  const [selectedFilter, setSelectedFilter] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [showLevelGuide, setShowLevelGuide] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);

  const captureScale = useRef(new Animated.Value(1)).current;
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const handleCapture = useCallback(() => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    Animated.sequence([
      Animated.timing(captureScale, { toValue: 0.88, duration: 80, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(captureScale, { toValue: 1, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start();

    const id = addUpload(`IMG_${Date.now()}.${settings.imageFormat}`, "image");
    setTimeout(() => updateUpload(id, { status: "done" }), 2000);
  }, [settings.imageFormat, addUpload, updateUpload, captureScale]);

  const handleVideoToggle = useCallback(() => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }
    if (!isRecording) {
      setIsRecording(true);
      setRecordSeconds(0);
      recordTimer.current = setInterval(() => setRecordSeconds(s => s + 1), 1000);
      const id = addUpload(`VID_${Date.now()}.${settings.videoFormat}`, "video");
      setTimeout(() => updateUpload(id, { status: "done" }), 5000);
    } else {
      setIsRecording(false);
      if (recordTimer.current) clearInterval(recordTimer.current);
      setRecordSeconds(0);
    }
  }, [isRecording, settings.videoFormat, addUpload, updateUpload]);

  const cycleFlash = () => {
    const next: FlashMode[] = ["auto", "on", "off"];
    const idx = next.indexOf(flash);
    setFlash(next[(idx + 1) % 3]!);
  };

  const flashIcon = flash === "on" ? "flash" : flash === "off" ? "flash-off" : "flash-outline";

  const formatTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const uploadStatusColor = !lastUpload ? "transparent"
    : lastUpload.status === "done" ? "#22c55e"
    : lastUpload.status === "failed" ? "#ef4444"
    : lastUpload.status === "uploading" ? "#b19870"
    : "#6b7280";

  const uploadStatusIcon = !lastUpload ? "cloud-outline"
    : lastUpload.status === "done" ? "cloud-done-outline"
    : lastUpload.status === "failed" ? "cloud-offline-outline"
    : "cloud-upload-outline";

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* Camera viewfinder area (web placeholder, real camera on device) */}
      <View style={styles.viewfinder}>
        <Text style={styles.viewfinderHint}>
          {Platform.OS === "web"
            ? "📷 Camera preview on device"
            : "Camera loading..."}
        </Text>
        {showLevelGuide && (
          <View style={styles.levelGuide}>
            <View style={styles.levelLine} />
            <View style={[styles.levelDot]} />
          </View>
        )}
        {selectedFilter > 0 && (
          <View style={[styles.filterOverlay, { opacity: 0.3 }]} />
        )}
      </View>

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

        <TouchableOpacity style={styles.iconBtn} onPress={() => router.push("/settings/index")}>
          <Ionicons name="settings-outline" size={24} color="white" />
        </TouchableOpacity>
      </View>

      {/* Upload status indicator */}
      {lastUpload && lastUpload.status !== "idle" && (
        <View style={[styles.uploadStatus, { top: insets.top + (Platform.OS === "web" ? 110 : 70) }]}>
          <Ionicons name={uploadStatusIcon as any} size={16} color={uploadStatusColor} />
          <Text style={[styles.uploadStatusText, { color: uploadStatusColor }]}>
            {lastUpload.status === "done" ? "Uploaded" : lastUpload.status === "failed" ? "Failed" : lastUpload.status === "uploading" ? "Uploading..." : "Queued"}
          </Text>
        </View>
      )}

      {/* Zoom controls */}
      <View style={styles.zoomContainer}>
        {[1, 2, 5].map(z => (
          <TouchableOpacity
            key={z}
            style={[styles.zoomBtn, zoom === z && styles.zoomBtnActive]}
            onPress={() => setZoom(z)}
          >
            <Text style={[styles.zoomText, zoom === z && styles.zoomTextActive]}>{z}×</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Filter row */}
      {showFilters && (
        <View style={styles.filterRow}>
          {FILTERS.map((f, i) => (
            <TouchableOpacity key={f} style={styles.filterChip} onPress={() => setSelectedFilter(i)}>
              <View style={[styles.filterThumb, { backgroundColor: i === 0 ? "#333" : `hsl(${i * 36}, 40%, 40%)`, borderWidth: selectedFilter === i ? 2 : 0, borderColor: PRIMARY }]} />
              <Text style={[styles.filterLabel, selectedFilter === i && { color: PRIMARY }]}>{f}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Bottom controls */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 16) }]}>
        {/* Mode selector */}
        <View style={styles.modeSelector}>
          {(["photo", "video"] as CameraMode[]).map(m => (
            <TouchableOpacity key={m} onPress={() => setMode(m)} style={styles.modeBtn}>
              <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>
                {m === "photo" ? "PHOTO" : "VIDEO"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.captureRow}>
          {/* Gallery / last upload cloud viewer */}
          <TouchableOpacity style={styles.sideBtn} onPress={() => setShowFilters(v => !v)}>
            <Feather name="sliders" size={22} color={showFilters ? PRIMARY : "white"} />
          </TouchableOpacity>

          {/* Capture Button */}
          <Animated.View style={{ transform: [{ scale: captureScale }] }}>
            <TouchableOpacity
              style={[styles.captureBtn, mode === "video" && { borderColor: "#ef4444" }]}
              onPress={mode === "photo" ? handleCapture : handleVideoToggle}
              activeOpacity={0.8}
            >
              {mode === "video" ? (
                <View style={[styles.captureInner, isRecording && styles.captureStop]} />
              ) : (
                <View style={styles.captureInner} />
              )}
            </TouchableOpacity>
          </Animated.View>

          {/* Flip Camera */}
          <TouchableOpacity style={styles.sideBtn} onPress={() => setFacing(f => f === "back" ? "front" : "back")}>
            <Ionicons name="camera-reverse-outline" size={26} color="white" />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  viewfinder: { ...StyleSheet.absoluteFillObject, backgroundColor: "#111", alignItems: "center", justifyContent: "center" },
  viewfinderHint: { color: "#555", fontSize: 14, fontFamily: "Inter_400Regular" },
  filterOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "#d4a574" },
  levelGuide: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  levelLine: { width: "60%", height: 1, backgroundColor: "rgba(177,152,112,0.6)" },
  levelDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#b19870", position: "absolute" },
  topBar: {
    position: "absolute", top: 0, left: 0, right: 0,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingBottom: 12,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  iconBtn: { padding: 8, borderRadius: 20 },
  recordingBadge: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(0,0,0,0.5)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#ef4444" },
  recordingTime: { color: "white", fontSize: 13, fontFamily: "Inter_500Medium" },
  uploadStatus: {
    position: "absolute", right: 16,
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 14, borderWidth: 1, borderColor: "rgba(177,152,112,0.3)",
  },
  uploadStatusText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  zoomContainer: { position: "absolute", bottom: 200, alignSelf: "center", flexDirection: "row", gap: 6 },
  zoomBtn: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 16, backgroundColor: "rgba(0,0,0,0.5)" },
  zoomBtnActive: { backgroundColor: "rgba(177,152,112,0.8)" },
  zoomText: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontFamily: "Inter_500Medium" },
  zoomTextActive: { color: "white" },
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
    backgroundColor: "rgba(0,0,0,0.8)", paddingTop: 12,
  },
  modeSelector: { flexDirection: "row", justifyContent: "center", gap: 24, marginBottom: 16 },
  modeBtn: { paddingVertical: 4 },
  modeText: { color: "rgba(255,255,255,0.4)", fontSize: 12, fontFamily: "Inter_600SemiBold", letterSpacing: 1.5 },
  modeTextActive: { color: "white" },
  captureRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 40, marginBottom: 8 },
  sideBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  captureBtn: {
    width: 80, height: 80, borderRadius: 40,
    borderWidth: 4, borderColor: PRIMARY,
    alignItems: "center", justifyContent: "center",
  },
  captureInner: { width: 64, height: 64, borderRadius: 32, backgroundColor: "white" },
  captureStop: { width: 30, height: 30, borderRadius: 6, backgroundColor: "#ef4444" },
});
