// Device-side handling of a finished capture: saving it to the phone's photo
// library and cleaning up the temporary files the capture pipeline leaves
// behind (raw frames, pre-bake originals, panorama strips, discarded scans).
import { Platform } from "react-native";
import { File } from "expo-file-system";

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
