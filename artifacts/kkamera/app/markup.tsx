import React, { useState, useRef, useCallback } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Image,
  Alert, ActivityIndicator, ScrollView, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, router } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { Path } from "react-native-svg";
import { captureRef } from "react-native-view-shot";
import { useAuth } from "@/contexts/AuthContext";
import { useUpload } from "@/contexts/UploadContext";
import { useSettings } from "@/contexts/SettingsContext";

const PRIMARY = "#b19870";
const BG = "#0d0b08";

const COLOURS = ["#ffffff", "#b19870", "#ef4444", "#22c55e", "#60a5fa", "#f59e0b", "#000000"];
const BRUSH_SIZES = [3, 6, 10, 16];

interface DrawnPath {
  d: string;
  color: string;
  width: number;
}

export default function MarkupScreen() {
  const insets = useSafeAreaInsets();
  const { uri, fileName } = useLocalSearchParams<{ uri: string; fileName: string }>();
  const { token } = useAuth();
  const { executeUpload } = useUpload();
  const { settings } = useSettings();

  const [paths, setPaths] = useState<DrawnPath[]>([]);
  const [currentPoints, setCurrentPoints] = useState<string>("");
  const [color, setColor] = useState(COLOURS[0]!);
  const [brushSize, setBrushSize] = useState(6);
  const [isUploading, setIsUploading] = useState(false);

  const captureViewRef = useRef<View>(null);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  const panGesture = Gesture.Pan()
    // Run callbacks on the JS thread so we can call React setState directly.
    // Without this, reanimated workletizes them onto the UI thread and calling
    // a non-worklet (setState) there crashes the app as soon as you draw.
    .runOnJS(true)
    .onStart((e) => {
      lastPoint.current = { x: e.x, y: e.y };
      setCurrentPoints(`M${e.x.toFixed(1)},${e.y.toFixed(1)}`);
    })
    .onUpdate((e) => {
      setCurrentPoints(p => `${p} L${e.x.toFixed(1)},${e.y.toFixed(1)}`);
      lastPoint.current = { x: e.x, y: e.y };
    })
    .onEnd(() => {
      if (currentPoints) {
        setPaths(prev => [...prev, { d: currentPoints, color, width: brushSize }]);
        setCurrentPoints("");
      }
      lastPoint.current = null;
    });

  const handleUndo = useCallback(() => {
    setPaths(prev => prev.slice(0, -1));
  }, []);

  const handleClear = useCallback(() => {
    if (paths.length === 0) return;
    Alert.alert("Clear markup?", "This will erase all drawn annotations.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: () => setPaths([]) },
    ]);
  }, [paths.length]);

  const captureMarked = async (): Promise<string | null> => {
    if (!captureViewRef.current) return null;
    try {
      const snapshot = await captureRef(captureViewRef, { format: "jpg", quality: 0.9 });
      return snapshot;
    } catch {
      return null;
    }
  };

  const handleUpload = useCallback(async (mode: "original" | "marked" | "both") => {
    if (!uri || !fileName) return;
    setIsUploading(true);
    try {
      if (mode === "original" || mode === "both") {
        await executeUpload(uri, fileName, "image", token);
      }
      if (mode === "marked" || mode === "both") {
        const markedUri = await captureMarked();
        if (markedUri) {
          const markedName = fileName.replace(/(\.[^.]+)$/, "_marked$1");
          await executeUpload(markedUri, markedName, "image", token);
        } else {
          Alert.alert("Markup Export Failed", "Could not capture the marked-up image. Uploading original instead.");
          if (mode === "marked") {
            await executeUpload(uri, fileName, "image", token);
          }
        }
      }
      router.back();
    } catch (err: any) {
      Alert.alert("Upload Failed", err?.message ?? "Could not upload.");
    } finally {
      setIsUploading(false);
    }
  }, [uri, fileName, token, executeUpload]);

  const defaultMode = settings.markupUploadMode;

  if (!uri) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={{ color: "white" }}>No image provided.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} disabled={isUploading}>
          <Ionicons name="close" size={24} color="white" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Markup</Text>
        <TouchableOpacity onPress={handleUndo} style={styles.headerBtn} disabled={paths.length === 0 || isUploading}>
          <Ionicons name="arrow-undo-outline" size={22} color={paths.length > 0 ? "white" : "#444"} />
        </TouchableOpacity>
      </View>

      {/* Canvas */}
      <GestureDetector gesture={panGesture}>
        <View ref={captureViewRef} style={styles.canvas} collapsable={false}>
          <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="contain" accessibilityLabel="Photo markup canvas" />
          <Svg style={StyleSheet.absoluteFill}>
            {paths.map((p, i) => (
              <Path
                key={i}
                d={p.d}
                stroke={p.color}
                strokeWidth={p.width}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
            {currentPoints !== "" && (
              <Path
                d={currentPoints}
                stroke={color}
                strokeWidth={brushSize}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </Svg>
        </View>
      </GestureDetector>

      {/* Toolbar */}
      <View style={styles.toolbar}>
        {/* Colours */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.colourRow}>
          {COLOURS.map(c => (
            <TouchableOpacity
              key={c}
              style={[styles.colourDot, { backgroundColor: c }, color === c && styles.colourDotActive]}
              onPress={() => setColor(c)}
            />
          ))}
        </ScrollView>

        {/* Brush sizes */}
        <View style={styles.brushRow}>
          {BRUSH_SIZES.map(s => (
            <TouchableOpacity key={s} style={[styles.brushBtn, brushSize === s && styles.brushBtnActive]} onPress={() => setBrushSize(s)}>
              <View style={[styles.brushDot, { width: Math.min(s * 1.8, 24), height: Math.min(s * 1.8, 24), borderRadius: s, backgroundColor: brushSize === s ? "#0d0b08" : "white" }]} />
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.clearBtn} onPress={handleClear}>
            <Ionicons name="trash-outline" size={18} color="#ef4444" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Upload options */}
      <View style={[styles.uploadBar, { paddingBottom: insets.bottom + 12 }]}>
        {isUploading ? (
          <View style={styles.uploadingRow}>
            <ActivityIndicator color={PRIMARY} />
            <Text style={styles.uploadingText}>Uploading…</Text>
          </View>
        ) : defaultMode === "original" ? (
          <TouchableOpacity style={styles.uploadBtnFull} onPress={() => handleUpload("original")}>
            <Ionicons name="cloud-upload-outline" size={18} color="white" />
            <Text style={styles.uploadBtnText}>Upload Original</Text>
          </TouchableOpacity>
        ) : defaultMode === "marked" ? (
          <TouchableOpacity style={styles.uploadBtnFull} onPress={() => handleUpload("marked")}>
            <Ionicons name="cloud-upload-outline" size={18} color="white" />
            <Text style={styles.uploadBtnText}>Upload Marked Version</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.uploadBtnRow}>
            <TouchableOpacity style={styles.uploadBtnSmall} onPress={() => handleUpload("original")}>
              <Text style={styles.uploadBtnSmallText}>Original</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.uploadBtnSmall, styles.uploadBtnSmallActive]} onPress={() => handleUpload("both")}>
              <Ionicons name="cloud-upload-outline" size={16} color="white" />
              <Text style={styles.uploadBtnText}>Upload Both</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.uploadBtnSmall} onPress={() => handleUpload("marked")}>
              <Text style={styles.uploadBtnSmallText}>Marked</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  center: { alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: "rgba(177,152,112,0.15)",
  },
  headerBtn: { padding: 8, width: 44, alignItems: "center" },
  headerTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white" },
  canvas: { flex: 1, backgroundColor: "#111" },
  toolbar: {
    backgroundColor: "#1a1710",
    borderTopWidth: 1, borderTopColor: "rgba(177,152,112,0.2)",
    paddingVertical: 10,
  },
  colourRow: { paddingHorizontal: 16, gap: 10, paddingBottom: 8 },
  colourDot: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: "transparent" },
  colourDotActive: { borderColor: PRIMARY, transform: [{ scale: 1.2 }] },
  brushRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 10 },
  brushBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "#2a2720",
  },
  brushBtnActive: { backgroundColor: PRIMARY },
  brushDot: {},
  clearBtn: { marginLeft: "auto", padding: 10 },
  uploadBar: {
    backgroundColor: "#13110e",
    borderTopWidth: 1, borderTopColor: "rgba(177,152,112,0.2)",
    paddingHorizontal: 16, paddingTop: 12,
  },
  uploadingRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 14 },
  uploadingText: { color: PRIMARY, fontSize: 14, fontFamily: "Inter_500Medium" },
  uploadBtnFull: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 14,
  },
  uploadBtnText: { color: "white", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  uploadBtnRow: { flexDirection: "row", gap: 8 },
  uploadBtnSmall: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    borderWidth: 1, borderColor: "rgba(177,152,112,0.35)", borderRadius: 14, paddingVertical: 13,
  },
  uploadBtnSmallActive: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  uploadBtnSmallText: { color: PRIMARY, fontSize: 13, fontFamily: "Inter_600SemiBold" },
});
