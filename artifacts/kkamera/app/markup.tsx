import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Image,
  Alert, ActivityIndicator, ScrollView, type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useNavigation, router } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { Path } from "react-native-svg";
import { captureRef } from "react-native-view-shot";
import { useAuth } from "@/contexts/AuthContext";
import { useUpload } from "@/contexts/UploadContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useUploadTargetResolver } from "@/lib/useUploadTargetResolver";
import { saveToCameraRoll, deleteTempFile, viewShotSize, notifyWitness } from "@/lib/captureStorage";

const PRIMARY = "#b19870";
const BG = "#0d0b08";

const COLOURS = ["#ffffff", "#b19870", "#ef4444", "#22c55e", "#60a5fa", "#f59e0b", "#000000"];
const BRUSH_SIZES = [3, 6, 10, 16];

/** Long-edge cap (px) for the exported marked-up image. */
const MAX_EXPORT_EDGE = 4096;

/** A stroke, in IMAGE pixel coordinates (independent of the screen). */
interface DrawnPath {
  d: string;
  color: string;
  width: number;
}

interface ExportConfig {
  renderW: number;
  renderH: number;
  dp: number;
  capture: { width: number; height: number };
}

export default function MarkupScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { uri, fileName } = useLocalSearchParams<{ uri: string; fileName: string }>();
  const { token } = useAuth();
  const { executeUpload } = useUpload();
  const { settings } = useSettings();
  const { getUploadTarget } = useUploadTargetResolver();

  const [paths, setPaths] = useState<DrawnPath[]>([]);
  // The live stroke is mirrored in a ref: gesture callbacks close over the
  // render they were created in, so reading state in onEnd would see a stale
  // (shorter) path and drop the last segment.
  const [currentPath, setCurrentPath] = useState<string>("");
  const currentRef = useRef<string>("");
  const [color, setColor] = useState(COLOURS[0]!);
  const [brushSize, setBrushSize] = useState(6);
  const [isUploading, setIsUploading] = useState(false);

  // The photo's pixel size and the canvas's on-screen size together give the
  // letterboxed rectangle the photo is shown in — and the mapping from touch
  // points to image pixels.
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [canvas, setCanvas] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!uri) return;
    let cancelled = false;
    Image.getSize(
      uri,
      (w, h) => { if (!cancelled && w > 0 && h > 0) setImgSize({ w, h }); },
      () => { /* keep null: drawing stays disabled rather than misplaced */ },
    );
    return () => { cancelled = true; };
  }, [uri]);
  const onCanvasLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setCanvas({ w: width, h: height });
  }, []);
  const view = imgSize && canvas
    ? (() => {
      const scale = Math.min(canvas.w / imgSize.w, canvas.h / imgSize.h);
      const w = imgSize.w * scale;
      const h = imgSize.h * scale;
      return { scale, x: (canvas.w - w) / 2, y: (canvas.h - h) / 2, w, h };
    })()
    : null;
  // Latest mapping/brush for the gesture callbacks.
  const viewRef = useRef(view);
  viewRef.current = view;
  const brushRef = useRef({ color, brushSize });
  brushRef.current = { color, brushSize };

  const toImage = (x: number, y: number) => {
    const v = viewRef.current!;
    return `${((x - v.x) / v.scale).toFixed(1)},${((y - v.y) / v.scale).toFixed(1)}`;
  };

  const panGesture = Gesture.Pan()
    // Run callbacks on the JS thread so we can call React setState directly.
    // Without this, reanimated workletizes them onto the UI thread and calling
    // a non-worklet (setState) there crashes the app as soon as you draw.
    .runOnJS(true)
    .enabled(view != null && !isUploading)
    .minDistance(0)
    .onStart((e) => {
      currentRef.current = `M${toImage(e.x, e.y)}`;
      setCurrentPath(currentRef.current);
    })
    .onUpdate((e) => {
      currentRef.current = `${currentRef.current} L${toImage(e.x, e.y)}`;
      setCurrentPath(currentRef.current);
    })
    .onFinalize(() => {
      const d = currentRef.current;
      currentRef.current = "";
      setCurrentPath("");
      const v = viewRef.current;
      if (!d || !v) return;
      const { color: c, brushSize: b } = brushRef.current;
      // Stroke width is chosen in screen px; store it in image px so the
      // export looks exactly like the screen.
      setPaths(prev => [...prev, { d, color: c, width: b / v.scale }]);
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

  // ── Full-resolution export ──────────────────────────────────────────────
  // The marked-up copy is rendered offscreen at the photo's own pixel size
  // (capped at MAX_EXPORT_EDGE), with the strokes in image coordinates, and
  // rasterised by view-shot at exactly that size — not a screen-sized snapshot
  // letterboxed in the canvas background.
  const [exportConfig, setExportConfig] = useState<ExportConfig | null>(null);
  const exportViewRef = useRef<View>(null);
  const exportResolver = useRef<((out: string | null) => void) | null>(null);
  const exportCaptured = useRef(false);

  const finishExport = useCallback((out: string | null) => {
    const resolve = exportResolver.current;
    exportResolver.current = null;
    setExportConfig(null);
    resolve?.(out);
  }, []);

  const captureExport = useCallback(async () => {
    if (!exportConfig || exportCaptured.current) return;
    exportCaptured.current = true;
    let out: string | null = null;
    try {
      // Give the strokes a frame to paint over the loaded image.
      await new Promise<void>(r => requestAnimationFrame(() => r()));
      const result = await captureRef(exportViewRef, {
        format: "jpg",
        quality: 0.92,
        result: "tmpfile",
        ...exportConfig.capture,
      });
      out = result.startsWith("/") ? `file://${result}` : result;
    } catch { out = null; }
    finishExport(out);
  }, [exportConfig, finishExport]);

  const abandonExport = useCallback(() => {
    if (exportCaptured.current) return;
    exportCaptured.current = true;
    finishExport(null);
  }, [finishExport]);

  useEffect(() => {
    if (!exportConfig) return;
    const t = setTimeout(abandonExport, 8000);
    return () => clearTimeout(t);
  }, [exportConfig, abandonExport]);

  const captureMarked = useCallback((): Promise<string | null> => {
    if (!imgSize) return Promise.resolve(null);
    const long = Math.max(imgSize.w, imgSize.h);
    const k = long > MAX_EXPORT_EDGE ? MAX_EXPORT_EDGE / long : 1;
    const renderW = Math.max(1, Math.round(imgSize.w * k));
    const renderH = Math.max(1, Math.round(imgSize.h * k));
    const shot = viewShotSize(renderW, renderH);
    exportCaptured.current = false;
    return new Promise(resolve => {
      exportResolver.current?.(null);
      exportResolver.current = resolve;
      setExportConfig({ renderW, renderH, dp: shot.dpPerPx, capture: shot.capture });
    });
  }, [imgSize]);

  // ── Leaving ─────────────────────────────────────────────────────────────
  // The photo exists only here until it's uploaded, so leaving (X, Android
  // back, iOS swipe) always asks — it is never silently dropped.
  const allowLeave = useRef(false);

  const handleUpload = useCallback(async (mode: "original" | "marked" | "both") => {
    if (!uri || !fileName) return;
    setIsUploading(true);
    try {
      // Honour the user's upload-destination default (same as the camera), so a
      // marked-up photo doesn't fan out to accounts they excluded. Offline, the
      // last known target is used — never a silent widening to "all".
      const target = await getUploadTarget();
      const onDeleteLocal = settings.deleteLocalAfterUpload ? undefined : async () => {};

      // Everything that reads the original (the export, library copies) runs
      // BEFORE it is queued: the upload queue may move the file.
      let markedUri: string | null = null;
      if (mode === "marked" || mode === "both") {
        markedUri = await captureMarked();
        if (!markedUri) {
          Alert.alert("Markup Export Failed", "Could not create the marked-up image. Uploading the original instead.");
        }
      }
      const markedName = fileName.replace(/(\.[^.]+)$/, "_marked$1");
      // The camera already put the original in the photo library (when that's
      // on); the annotated copy is new, so it goes there too.
      const keepMarked = markedUri != null && (settings.saveToCameraRoll || target.skip);
      const markedSaved = keepMarked ? (await saveToCameraRoll(markedUri!)) === "saved" : false;

      if (target.skip) {
        // "Don't upload": the photo library is the only destination.
        if (markedUri && markedSaved) deleteTempFile(markedUri);
        allowLeave.current = true;
        router.back();
        return;
      }

      // The witness is told about each version only once it has REALLY been
      // uploaded (onUploaded), never on queueing — and never for a version
      // that isn't sent.
      const witness = (name: string) => () => notifyWitness({
        enabled: settings.witnessOnSuccess,
        witnessEmail: settings.witnessEmail,
        token,
        fileName: name,
      });

      // The upload queue persists each capture and returns quickly; it also
      // owns the Wi-Fi-only rule, so nothing here waits on the network.
      const sendOriginal = mode === "original" || mode === "both" || (mode === "marked" && !markedUri);
      if (sendOriginal) {
        void executeUpload(uri, fileName, "image", token, target.ids, onDeleteLocal, witness(fileName));
      } else if (settings.deleteLocalAfterUpload) {
        // Marked-only: the unannotated temp file isn't going anywhere.
        deleteTempFile(uri);
      }
      if (markedUri) {
        void executeUpload(markedUri, markedName, "image", token, target.ids, onDeleteLocal, witness(markedName));
      }
      allowLeave.current = true;
      router.back();
    } catch (err: any) {
      Alert.alert("Upload Failed", err?.message ?? "Could not upload.");
    } finally {
      setIsUploading(false);
    }
  }, [uri, fileName, token, executeUpload, getUploadTarget, captureMarked,
    settings.deleteLocalAfterUpload, settings.saveToCameraRoll, settings.witnessOnSuccess, settings.witnessEmail]);

  const handleUploadRef = useRef(handleUpload);
  handleUploadRef.current = handleUpload;

  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", (e: any) => {
      if (allowLeave.current || !uri) return;
      e.preventDefault();
      Alert.alert(
        "Discard this photo?",
        "It hasn't been uploaded yet.",
        [
          { text: "Keep editing", style: "cancel" },
          { text: "Upload original", onPress: () => { void handleUploadRef.current("original"); } },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => {
              deleteTempFile(uri);
              allowLeave.current = true;
              navigation.dispatch(e.data.action);
            },
          },
        ],
        { cancelable: true },
      );
    });
    return unsubscribe;
  }, [navigation, uri]);

  const defaultMode = settings.markupUploadMode;

  if (!uri) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={{ color: "white" }}>No image provided.</Text>
      </View>
    );
  }

  const strokes = (list: DrawnPath[], live: string) => (
    <>
      {list.map((p, i) => (
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
      {live !== "" && view && (
        <Path
          d={live}
          stroke={color}
          strokeWidth={brushSize / view.scale}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </>
  );

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
        <View style={styles.canvas} collapsable={false} onLayout={onCanvasLayout}>
          <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="contain" accessibilityLabel="Photo markup canvas" />
          {view && imgSize && (
            <Svg
              style={{ position: "absolute", left: view.x, top: view.y, width: view.w, height: view.h }}
              width={view.w}
              height={view.h}
              viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
              pointerEvents="none"
            >
              {strokes(paths, currentPath)}
            </Svg>
          )}
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

      {/* Offscreen full-resolution composition for the marked-up export */}
      {exportConfig && imgSize && (
        <View
          ref={exportViewRef}
          collapsable={false}
          pointerEvents="none"
          style={{
            position: "absolute", left: -100000, top: 0,
            width: exportConfig.renderW * exportConfig.dp,
            height: exportConfig.renderH * exportConfig.dp,
          }}
        >
          <Image
            source={{ uri }}
            style={{ width: exportConfig.renderW * exportConfig.dp, height: exportConfig.renderH * exportConfig.dp }}
            resizeMode="stretch"
            fadeDuration={0}
            onLoad={captureExport}
            onError={abandonExport}
          />
          <Svg
            style={StyleSheet.absoluteFill}
            width={exportConfig.renderW * exportConfig.dp}
            height={exportConfig.renderH * exportConfig.dp}
            viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
          >
            {strokes(paths, "")}
          </Svg>
        </View>
      )}
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
