// Device-side handling of a finished capture: saving it to the phone's photo
// library and cleaning up the temporary files the capture pipeline leaves
// behind (raw frames, pre-bake originals, panorama strips, discarded scans).
import { Platform, PixelRatio } from "react-native";
import { File } from "expo-file-system";
import { API_BASE_URL } from "@/lib/config";

// expo-media-library is native-only; import it lazily so the web bundle never
// evaluates it (see .agents/memory/expo-web-module-crashes.md).
async function getMediaLibrary() {
  if (Platform.OS === "web") return null;
  return await import("expo-media-library");
}

export type CameraRollResult = "saved" | "denied" | "unavailable" | "failed";

/**
 * Copy a capture into the device photo library. Asks for add-only ("write
 * only") access the first time — KKamera never needs to read the library to do
 * this. Never throws.
 */
export async function saveToCameraRoll(uri: string): Promise<CameraRollResult> {
  try {
    const MediaLibrary = await getMediaLibrary();
    if (!MediaLibrary) return "unavailable";
    let perm = await MediaLibrary.getPermissionsAsync(true, ["photo", "video"]);
    if (!perm.granted && perm.canAskAgain) {
      perm = await MediaLibrary.requestPermissionsAsync(true, ["photo", "video"]);
    }
    if (!perm.granted) return "denied";
    await MediaLibrary.saveToLibraryAsync(uri);
    return "saved";
  } catch {
    return "failed";
  }
}

/**
 * Best-effort delete of a temporary capture file. Uses the SDK 54 File API —
 * the legacy `deleteAsync` export is a stub that always throws.
 */
export function deleteTempFile(uri: string | null | undefined) {
  if (!uri || Platform.OS === "web") return;
  if (!uri.startsWith("file:")) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch { /* best-effort */ }
}

/** File extension of a capture uri (lower-case, no dot), or `fallback`. */
export function extensionOf(uri: string, fallback: string): string {
  const path = (uri.split("?")[0] ?? uri).split("#")[0] ?? uri;
  const last = path.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0 || dot === last.length - 1) return fallback;
  return last.slice(dot + 1).toLowerCase();
}

/**
 * Sizes for rasterising an offscreen view to exactly `pxW` × `pxH` pixels with
 * react-native-view-shot.
 *
 * Layout is in dp, so the view is laid out at px / PixelRatio (its native
 * backing store is then ~px wide, not px × 3). The `captureRef` width/height
 * options differ per platform: Android takes output pixels, iOS takes points
 * and multiplies them by the screen scale. Without this, a "2048 px" view was
 * rendered at 6144 px on a 3× phone — a large memory spike — and iOS output
 * came out at 3× the intended size.
 */
export function viewShotSize(pxW: number, pxH: number) {
  const pr = Platform.OS === "web" ? 1 : PixelRatio.get() || 1;
  const w = Math.max(1, Math.round(pxW));
  const h = Math.max(1, Math.round(pxH));
  return {
    /** dp per output pixel — multiply px geometry by this for layout. */
    dpPerPx: 1 / pr,
    layout: { width: w / pr, height: h / pr },
    capture: Platform.OS === "ios"
      ? { width: w / pr, height: h / pr }
      : { width: w, height: h },
  };
}

/**
 * Witness mode: email the configured witness that `fileName` was uploaded.
 * Callers must only invoke this once the upload has really completed (see the
 * `onUploaded` callback of executeUpload). Fire-and-forget; never throws.
 */
export function notifyWitness(opts: {
  enabled: boolean;
  witnessEmail: string;
  token: string | null | undefined;
  fileName: string;
}) {
  if (!opts.enabled || !opts.witnessEmail || !opts.token) return;
  fetch(`${API_BASE_URL}/api/uploads/witness-notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
    body: JSON.stringify({ witnessEmail: opts.witnessEmail, fileName: opts.fileName }),
  }).catch(() => {});
}
