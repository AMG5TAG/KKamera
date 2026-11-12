/**
 * The zoom stops offered by the camera's zoom rail and the "Default Zoom"
 * setting.
 *
 * `value` is expo-camera's normalised `zoom` prop — NOT a focal length:
 *  - 0 is the lens's native field of view (a true 1× on the main camera; the
 *    native layers clamp the zoom factor to ≥ 1, so it never goes wider).
 *  - 1 is the device's maximum (mostly digital) zoom.
 *  - In between is platform-specific: iOS uses `maxZoom ^ value`, Android a
 *    linear `value × maxZoom`. The maximum varies from phone to phone, so no
 *    fixed "2×/5×/10×" label could be honest for a given value.
 *
 * The labels are therefore relative ("1×", "+", "++", "Max"). A real
 * ultra-wide ("0.5×") is only offered on iOS, where expo-camera lets us switch
 * to the physical ultra-wide lens (see `ULTRA_WIDE_LENS_PATTERN`).
 *
 * Shared so the camera screen and the settings screen can't drift apart.
 */
export const ZOOM_LEVELS = [
  { value: 0, label: "1×", name: "1× (no zoom)" },
  { value: 0.2, label: "+", name: "Light" },
  { value: 0.45, label: "++", name: "Strong" },
  { value: 1, label: "Max", name: "Max" },
] as const;

export type ZoomValue = (typeof ZOOM_LEVELS)[number]["value"];

/** Zoom the rear camera opens at when the user hasn't chosen otherwise (true 1×). */
export const DEFAULT_ZOOM: ZoomValue = 0;

/** The front camera has no optical zoom range worth using — always start at 1×. */
export const FRONT_CAMERA_ZOOM: ZoomValue = 0;

/**
 * iOS reports lenses by their localized AVCaptureDevice name, e.g.
 * "Back Ultra Wide Camera". Matched case-insensitively.
 */
export const ULTRA_WIDE_LENS_PATTERN = /ultra\s*wide/i;

/**
 * The real magnification for a normalised zoom, given the device's zoom range
 * (`minFactor` = the lens's neutral 1×, `maxFactor` = its maximum), using the
 * same mapping the native layers apply: iOS `min × (max/min)^value`, Android a
 * linear `value × max` clamped to ≥ 1. Null when the range isn't known.
 */
export function zoomFactor(
  value: number,
  range: { minFactor?: number; maxFactor: number } | null | undefined,
  platform: "ios" | "android" | string,
): number | null {
  if (!range || !Number.isFinite(range.maxFactor) || range.maxFactor <= 1) return null;
  const v = Math.min(1, Math.max(0, value));
  const min = range.minFactor && range.minFactor > 0 ? range.minFactor : 1;
  if (platform === "ios") return min * Math.pow(range.maxFactor / min, v);
  if (platform === "android") return Math.max(1, v * range.maxFactor);
  return null;
}

/** "2×", "2.5×", "10×" — one decimal below 10×, whole numbers above. */
function formatFactor(f: number): string {
  const r = f < 10 ? Math.round(f * 10) / 10 : Math.round(f);
  return `${r}×`;
}

/**
 * Short label for an arbitrary normalised zoom (e.g. after a pinch). With the
 * device's zoom range it is the real factor ("2×", "5×"); without it — which
 * is the case today, as expo-camera doesn't report the range to JS — it falls
 * back to the relative stop labels ("+", "++", "Max") or a percentage.
 */
export function zoomLabel(
  value: number,
  range?: { minFactor?: number; maxFactor: number } | null,
  platform?: string,
): string {
  if (value <= 0.02) return "1×";
  const f = platform ? zoomFactor(value, range, platform) : null;
  if (f != null) return formatFactor(f);
  const exact = ZOOM_LEVELS.find(z => Math.abs(z.value - value) < 0.03);
  if (exact) return exact.label;
  return `${Math.round(value * 100)}%`;
}

/**
 * Map a stored "Default Zoom" to a current stop. Pre-v2 builds stored
 * 0 ("·5"), 0.25 ("1×"), 0.5 ("2×"), 0.75 ("5×") and 1 ("10×"); the old "·5"
 * and "1×" both become a true 1× (0), and the rest snap to the nearest stop.
 */
export function migrateStoredZoom(v: unknown, legacy: boolean): ZoomValue {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_ZOOM;
  if (legacy) {
    if (v <= 0.25) return 0;
    if (v <= 0.5) return 0.2;
    if (v < 1) return 0.45;
    return 1;
  }
  let best: ZoomValue = DEFAULT_ZOOM;
  let bestD = Infinity;
  for (const z of ZOOM_LEVELS) {
    const d = Math.abs(z.value - v);
    if (d < bestD) { bestD = d; best = z.value; }
  }
  return best;
}
