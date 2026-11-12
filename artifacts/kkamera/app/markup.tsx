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
import { CommittedStrokes, arrowPath, type DrawnPath } from "@/components/markup/StrokeLayer";
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
// Spoken names for the swatches and brush sizes (screen readers).
const COLOUR_NAMES: Record<string, string> = {
  "#ffffff": "White", "#b19870": "Gold", "#ef4444": "Red", "#22c55e": "Green",
  "#60a5fa": "Blue", "#f59e0b": "Orange", "#000000": "Black",
};
const BRUSH_NAMES = ["Fine", "Medium", "Thick", "Extra thick"];

/** Long-edge cap (px) for the exported marked-up image. */
const MAX_EXPORT_EDGE = 4096;

type Tool = "pen" | "arrow";

interface ExportConfig {
  renderW: number;
  renderH: number;
  dp: number;
  capture: { width: number; height: number };
}

export default function MarkupScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { uri, fileName, markedOnly: markedOnlyParam } =
    useLocalSearchParams<{ uri: string; fileName: string; markedOnly?: string }>();
  // Opened from the camera's last-capture thumbnail: the original is already
  // in the upload queue, so only a marked copy can be uploaded from here, and
  // the (preview) file is never deleted or re-uploaded.
  const markedOnly = markedOnlyParam === "1";
  const { token } = useAuth();
  const { executeUpload } = useUpload();
  const { settings } = useSettings();
  const { getUploadTarget } = useUploadTargetResolver();

  const [paths, setPaths] = useState<DrawnPath[]>([]);
  // Strokes taken off by Undo, most recent last; any new stroke clears it.
  const [redoStack, setRedoStack] = useState<DrawnPath[]>([]);
  const [tool, setTool] = useState<Tool>("pen");
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
  const brushRef = useRef({ color, brushSize, tool });
  brushRef.current = { color, brushSize, tool };
  // Arrow tool: where the drag started, in image px.
  const arrowStart = useRef<{ x: number; y: number } | null>(null);

  const toImagePt = (x: number, y: number) => {
    const v = viewRef.current!;
    return { x: (x - v.x) / v.scale, y: (y - v.y) / v.scale };
  };
  const toImage = (x: number, y: number) => {
    const p = toImagePt(x, y);
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  };
  const arrowTo = (x: number, y: number) => {
    const start = arrowStart.current!;
    const end = toImagePt(x, y);
    return arrowPath(start.x, start.y, end.x, end.y, brushRef.current.brushSize / viewRef.current!.scale);
  };

  const panGesture = Gesture.Pan()
    // Run callbacks on the JS thread so we can call React setState directly.
    // Without this, reanimated workletizes them onto the UI thread and calling
    // a non-worklet (setState) there crashes the app as soon as you draw.
    .runOnJS(true)
    .enabled(view != null && !isUploading)
    .minDistance(0)
    .onStart((e) => {
      if (brushRef.current.tool === "arrow") {
        arrowStart.current = toImagePt(e.x, e.y);
        currentRef.current = arrowTo(e.x, e.y);
      } else {
        arrowStart.current = null;
        currentRef.current = `M${toImage(e.x, e.y)}`;
      }
      setCurrentPath(currentRef.current);
    })
    .onUpdate((e) => {
      currentRef.current = arrowStart.current
        ? arrowTo(e.x, e.y)
        : `${currentRef.current} L${toImage(e.x, e.y)}`;
      setCurrentPath(currentRef.current);
    })
    .onFinalize(() => {
      const d = currentRef.current;
      currentRef.current = "";
      arrowStart.current = null;
      setCurrentPath("");
      const v = viewRef.current;
      if (!d || !v) return;
      const { color: c, brushSize: b } = brushRef.current;
      // Stroke width is chosen in screen px; store it in image px so the
      // export looks exactly like the screen.
      setPaths(prev => [...prev, { d, color: c, width: b / v.scale }]);
      setRedoStack([]);
    });

  const handleUndo = useCallback(() => {
    if (paths.length === 0) return;
    const last = paths[paths.length - 1]!;
    setPaths(paths.slice(0, -1));
    setRedoStack(prev => [...prev, last]);
  }, [paths]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1]!;
    setRedoStack(redoStack.slice(0, -1));
    setPaths(prev => [...prev, next]);
  }, [redoStack]);

  const handleClear = useCallback(() => {
    if (paths.length === 0) return;
    Alert.alert("Clear markup?", "This will erase all drawn annotations.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: () => { setPaths([]); setRedoStack([]); } },
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

  const handleUpload = useCallback(async (requested: "original" | "marked" | "both") => {
    if (!uri || !fileName) return;
    if (markedOnly && paths.length === 0) return;
    // With nothing drawn, a "marked" copy would just duplicate the original.
    const mode = paths.length === 0 && !markedOnly ? "original" : requested;
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
          if (markedOnly) {
            // The original is already queued — there's nothing to fall back to.
            Alert.alert("Markup Export Failed", "Could not create the marked-up image. Please try again.");
            return;
          }
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
      const sendOriginal = !markedOnly
        && (mode === "original" || mode === "both" || (mode === "marked" && !markedUri));
      if (sendOriginal) {
        void executeUpload(uri, fileName, "image", token, target.ids, onDeleteLocal, witness(fileName));
      } else if (settings.deleteLocalAfterUpload && !markedOnly) {
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
  }, [uri, fileName, token, executeUpload, getUploadTarget, captureMarked, markedOnly, paths.length,
    settings.deleteLocalAfterUpload, settings.saveToCameraRoll, settings.witnessOnSuccess, settings.witnessEmail]);

  const handleUploadRef = useRef(handleUpload);
  handleUploadRef.current = handleUpload;
  const hasStrokesRef = useRef(false);
  hasStrokesRef.current = paths.length > 0;

  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", (e: any) => {
      if (allowLeave.current || !uri) return;
      if (markedOnly) {
        // The original is already uploading; only unsaved strokes are at stake.
        if (!hasStrokesRef.current) return;
        e.preventDefault();
        Alert.alert("Discard markup?", "Your annotations haven't been uploaded.", [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => { allowLeave.current = true; navigation.dispatch(e.data.action); },
          },
        ], { cancelable: true });
        return;
      }
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
  }, [navigation, uri, markedOnly]);

  const defaultMode = settings.markupUploadMode;

  if (!uri) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/camera"))}
            style={styles.headerBtn}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Ionicons name="chevron-back" size={24} color="white" />
          </TouchableOpacity>
          <Text style={styles.headerTitle} accessibilityRole="header">Markup</Text>
          <View style={styles.headerBtn} />
        </View>
        <View style={[styles.container, styles.center]}>
          <Text style={{ color: "white" }}>No image provided.</Text>
        </View>
      </View>
    );
  }

  const hasStrokes = paths.length > 0;

  // Committed strokes are a memoised layer; only the live stroke re-renders
  // on each pan update.
  const strokes = (list: DrawnPath[], live: string) => (
    <>
      <CommittedStrokes paths={list} />
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
        {/* Same width as the undo/redo pair so the title stays centred. */}
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.headerBtn}
            disabled={isUploading}
            accessibilityRole="button"
            accessibilityLabel="Close markup"
            accessibilityState={{ disabled: isUploading }}
          >
            <Ionicons name="close" size={24} color="white" />
          </TouchableOpacity>
          <View style={styles.headerBtn} />
        </View>
        <Text style={styles.headerTitle} accessibilityRole="header">Markup</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            onPress={handleUndo}
            style={styles.headerBtn}
            disabled={!hasStrokes || isUploading}
            accessibilityRole="button"
            accessibilityLabel="Undo last stroke"
            accessibilityState={{ disabled: !hasStrokes || isUploading }}
          >
            <Ionicons name="arrow-undo-outline" size={22} color={hasStrokes ? "white" : "#444"} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleRedo}
            style={styles.headerBtn}
            disabled={redoStack.length === 0 || isUploading}
            accessibilityRole="button"
            accessibilityLabel="Redo stroke"
            accessibilityState={{ disabled: redoStack.length === 0 || isUploading }}
          >
            <Ionicons name="arrow-redo-outline" size={22} color={redoStack.length > 0 ? "white" : "#444"} />
          </TouchableOpacity>
        </View>
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
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`${COLOUR_NAMES[c] ?? c} pen colour`}
              accessibilityState={{ selected: color === c }}
            />
          ))}
        </ScrollView>

        {/* Brush sizes */}
        <View style={styles.brushRow}>
          {BRUSH_SIZES.map((s, i) => (
            <TouchableOpacity
              key={s}
              style={[styles.brushBtn, brushSize === s && styles.brushBtnActive]}
              onPress={() => setBrushSize(s)}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel={`${BRUSH_NAMES[i] ?? `Size ${s}`} brush`}
              accessibilityState={{ selected: brushSize === s }}
            >
              <View style={[styles.brushDot, { width: Math.min(s * 1.8, 24), height: Math.min(s * 1.8, 24), borderRadius: s, backgroundColor: brushSize === s ? "#0d0b08" : "white" }]} />
            </TouchableOpacity>
          ))}
          <View style={styles.toolDivider} />
          <TouchableOpacity
            style={[styles.brushBtn, tool === "pen" && styles.brushBtnActive]}
            onPress={() => setTool("pen")}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel="Pen tool"
            accessibilityState={{ selected: tool === "pen" }}
          >
            <Ionicons name="brush-outline" size={18} color={tool === "pen" ? "#0d0b08" : "white"} accessible={false} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.brushBtn, tool === "arrow" && styles.brushBtnActive]}
            onPress={() => setTool("arrow")}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel="Arrow tool"
            accessibilityState={{ selected: tool === "arrow" }}
          >
            <Ionicons name="arrow-forward" size={18} color={tool === "arrow" ? "#0d0b08" : "white"} accessible={false} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.clearBtn}
            onPress={handleClear}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel="Clear all markup"
          >
            <Ionicons name="trash-outline" size={18} color="#ef4444" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Upload options */}
      <View style={[styles.uploadBar, { paddingBottom: insets.bottom + 12 }]}>
        {isUploading ? (
          <View style={styles.uploadingRow} accessible accessibilityLabel="Uploading">
            <ActivityIndicator color={PRIMARY} />
            <Text style={styles.uploadingText}>Uploading…</Text>
          </View>
        ) : markedOnly ? (
          <TouchableOpacity
            style={[styles.uploadBtnFull, !hasStrokes && styles.btnDisabled]}
            onPress={() => handleUpload("marked")}
            disabled={!hasStrokes}
            accessibilityRole="button"
            accessibilityHint={hasStrokes ? "The original has already been uploaded" : "Draw on the photo first"}
            accessibilityState={{ disabled: !hasStrokes }}
          >
            <Ionicons name="cloud-upload-outline" size={18} color="white" accessible={false} />
            <Text style={styles.uploadBtnText}>Upload Marked Copy</Text>
          </TouchableOpacity>
        ) : defaultMode === "original" ? (
          <TouchableOpacity style={styles.uploadBtnFull} onPress={() => handleUpload("original")} accessibilityRole="button">
            <Ionicons name="cloud-upload-outline" size={18} color="white" accessible={false} />
            <Text style={styles.uploadBtnText}>Upload Original</Text>
          </TouchableOpacity>
        ) : defaultMode === "marked" ? (
          <TouchableOpacity style={styles.uploadBtnFull} onPress={() => handleUpload("marked")} accessibilityRole="button">
            <Ionicons name="cloud-upload-outline" size={18} color="white" accessible={false} />
            <Text style={styles.uploadBtnText}>{hasStrokes ? "Upload Marked Version" : "Upload Original"}</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.uploadBtnRow}>
            <TouchableOpacity
              style={styles.uploadBtnSmall}
              onPress={() => handleUpload("original")}
              accessibilityRole="button"
              accessibilityLabel="Upload original only"
            >
              <Text style={styles.uploadBtnSmallText}>Original</Text>
            </TouchableOpacity>
            {/* With nothing drawn, Both/Marked would only duplicate the original. */}
            <TouchableOpacity
              style={[styles.uploadBtnSmall, styles.uploadBtnSmallActive, !hasStrokes && styles.btnDisabled]}
              onPress={() => handleUpload("both")}
              disabled={!hasStrokes}
              accessibilityRole="button"
              accessibilityLabel="Upload both original and marked versions"
              accessibilityState={{ disabled: !hasStrokes }}
            >
              <Ionicons name="cloud-upload-outline" size={16} color="white" accessible={false} />
              <Text style={styles.uploadBtnText}>Upload Both</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.uploadBtnSmall, !hasStrokes && styles.btnDisabled]}
              onPress={() => handleUpload("marked")}
              disabled={!hasStrokes}
              accessibilityRole="button"
              accessibilityLabel="Upload marked version only"
              accessibilityState={{ disabled: !hasStrokes }}
            >
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
  headerActions: { flexDirection: "row" },
  toolDivider: { width: 1, height: 24, backgroundColor: "rgba(255,255,255,0.12)" },
  btnDisabled: { opacity: 0.4 },
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
