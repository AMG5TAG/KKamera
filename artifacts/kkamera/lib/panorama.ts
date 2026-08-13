/**
 * Panorama sweep geometry.
 *
 * There is no on-device feature-matching stitcher available in an Expo managed
 * build (no OpenCV, no image-manipulator), so PANO mode uses the classic
 * strip-sampling approach instead: capture a frame every few degrees while the
 * user pans, then take a vertical strip from the centre of each frame and lay
 * the strips side by side. Sampling the centre keeps each strip close to the
 * lens axis, where distortion is lowest, and the seams land in the overlap
 * between consecutive frames.
 *
 * That composition is done by rendering the strips into an offscreen row and
 * rasterising it with react-native-view-shot — the same mechanism camera.tsx
 * already uses to bake stamps into a photo.
 *
 * This module is pure geometry so the maths stays reviewable on its own.
 */

/** Degrees of yaw between captured frames. */
export const PANO_STEP_DEG = 12;

/** Sweep at which the capture auto-completes. */
export const PANO_MAX_SWEEP_DEG = 180;

/** Hard cap on frames held in memory during a sweep. */
export const PANO_MAX_FRAMES = 24;

/**
 * Assumed horizontal field of view of a phone's main camera. Only the ratio
 * `PANO_STEP_DEG / hfov` matters — it sets how wide a strip each frame
 * contributes, i.e. how much consecutive frames overlap.
 */
export const PANO_ASSUMED_HFOV_DEG = 60;

/**
 * Fewest frames worth stitching. Each frame contributes `step/hfov` of its
 * width, so below `hfov/step` frames the composite is *narrower* than a single
 * ordinary photo — not a panorama, just a cropped one. Short sweeps are saved
 * as a plain frame instead.
 */
export const PANO_MIN_FRAMES = Math.ceil(PANO_ASSUMED_HFOV_DEG / PANO_STEP_DEG);

/** Upper bound on the composed image's width, to keep the raster affordable. */
export const PANO_MAX_OUTPUT_W = 4800;

/** Height each frame is rendered at while compositing. */
export const PANO_RENDER_H = 1080;

/** Capture cadence when no motion sensor is available to drive the sweep. */
export const PANO_FALLBACK_INTERVAL_MS = 700;

/**
 * A yaw jump larger than this between two sensor ticks is treated as noise (or
 * a compass wrap) rather than real motion, and ignored.
 */
export const PANO_MAX_PLAUSIBLE_STEP_DEG = 45;

/**
 * Shortest signed difference from `from` to `to`, in degrees, wrapped to
 * (-180, 180]. Yaw readings wrap at 360°, so a naive subtraction reports a 359°
 * jump when the user pans one degree across the boundary.
 */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Fold a raw sensor reading into a running sweep total.
 *
 * Returns the new total and whether the reading was used — an implausible jump
 * is dropped so a glitchy magnetometer can't race the sweep to completion.
 * `prevYaw` is null on the first reading, which only seeds the baseline.
 */
export function accumulateSweep(
  prevYaw: number | null,
  yaw: number,
  total: number,
): { total: number; accepted: boolean } {
  if (prevYaw == null) return { total, accepted: false };
  const d = angleDelta(prevYaw, yaw);
  if (Math.abs(d) > PANO_MAX_PLAUSIBLE_STEP_DEG) return { total, accepted: false };
  // Absolute value: panning right-to-left is just as valid as left-to-right.
  return { total: total + Math.abs(d), accepted: true };
}

export interface PanoLayout {
  /** Width each source frame is rendered at. */
  frameW: number;
  /** Height each source frame is rendered at (also the output height). */
  frameH: number;
  /** Width of the centre strip taken from each frame. */
  sliceW: number;
  /** Left offset applied to a frame so its centre strip fills the slice. */
  frameOffsetX: number;
  outW: number;
  outH: number;
}

/**
 * Work out the offscreen composition's geometry.
 *
 * Frames are scaled to a common height, each contributes a centre strip
 * `stepDeg/hfov` of its width, and the whole row is scaled down again if it
 * would exceed `maxOutW`.
 */
export function panoLayout(opts: {
  frameW: number;
  frameH: number;
  frameCount: number;
  stepDeg?: number;
  hfovDeg?: number;
  renderH?: number;
  maxOutW?: number;
}): PanoLayout {
  const {
    stepDeg = PANO_STEP_DEG,
    hfovDeg = PANO_ASSUMED_HFOV_DEG,
    renderH = PANO_RENDER_H,
    maxOutW = PANO_MAX_OUTPUT_W,
  } = opts;

  // Fall back to a sane portrait frame when the camera didn't report a size.
  const srcW = opts.frameW > 0 ? opts.frameW : 1080;
  const srcH = opts.frameH > 0 ? opts.frameH : 1440;
  const count = Math.max(1, Math.floor(opts.frameCount));
  const aspect = srcW / srcH;

  const build = (h: number): PanoLayout => {
    const frameH = Math.max(1, Math.round(h));
    const frameW = Math.max(1, Math.round(frameH * aspect));
    // Clamp to the frame: a step wider than the lens sees can't be covered, and
    // a zero-width strip would drop the frame entirely.
    const ratio = Math.min(1, Math.max(0.05, stepDeg / hfovDeg));
    const sliceW = Math.max(1, Math.min(frameW, Math.round(frameW * ratio)));
    return {
      frameW,
      frameH,
      sliceW,
      frameOffsetX: -Math.round((frameW - sliceW) / 2),
      outW: sliceW * count,
      outH: frameH,
    };
  };

  const first = build(Math.min(srcH, renderH));
  if (first.outW <= maxOutW) return first;
  return build(Math.min(srcH, renderH) * (maxOutW / first.outW));
}
