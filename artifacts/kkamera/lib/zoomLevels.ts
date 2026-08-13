/**
 * The zoom stops offered by the camera's zoom rail and the "Default Zoom"
 * setting.
 *
 * `value` is expo-camera's normalised zoom (0 = widest the lens goes, 1 = maximum
 * digital zoom); `label` is the focal-length shorthand shown to the user. Shared
 * so the camera screen and the settings screen can't drift apart on either.
 */
export const ZOOM_LEVELS = [
  { value: 0, label: "·5" },
  { value: 0.25, label: "1×" },
  { value: 0.5, label: "2×" },
  { value: 0.75, label: "5×" },
  { value: 1, label: "10×" },
] as const;

export type ZoomValue = (typeof ZOOM_LEVELS)[number]["value"];

/** Zoom the rear camera opens at when the user hasn't chosen otherwise (1×). */
export const DEFAULT_ZOOM: ZoomValue = 0.25;

/** The front camera has no optical zoom range worth using — always start wide. */
export const FRONT_CAMERA_ZOOM: ZoomValue = 0;
