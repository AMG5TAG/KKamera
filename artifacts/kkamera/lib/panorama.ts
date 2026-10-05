/**
 * Panorama sweep geometry.
 *
 * There is no on-device feature-matching stitcher available in an Expo managed
 * build (no OpenCV, no image-manipulator), so PANO mode uses the classic
 * strip-sampling approach instead: capture a frame every few degrees while the
 * user pans, then lay the frames side by side, each contributing the vertical
 * strip of the scene nearest its own lens axis (where distortion is lowest).
 *
 * Each frame records the sweep angle it was taken at, so the strip each one
 * contributes is sized from the *measured* angle to its neighbours rather than
 * from the nominal step — a late shutter no longer repeats or skips scenery.
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

/** Hard cap on frames held during a sweep. */
export const PANO_MAX_FRAMES = 24;

/**
 * Horizontal field of view of a typical phone main camera (≈26 mm equivalent,
 * 4:3 sensor). Held in portrait the horizontal edge is the sensor's SHORT
 * side, so it sees much less than in landscape — using one number for both
 * made portrait sweeps repeat scenery between strips.
 */
export const PANO_HFOV_LANDSCAPE_DEG = 67;
export const PANO_HFOV_PORTRAIT_DEG = 53;

/** Horizontal FOV for a frame of this shape (portrait vs landscape). */
export function estimateHfovDeg(frameW: number, frameH: number): number {
  if (frameW > 0 && frameH > 0 && frameW > frameH) return PANO_HFOV_LANDSCAPE_DEG;
  return PANO_HFOV_PORTRAIT_DEG;
}

/**
 * Fewest frames worth stitching. Fewer than this means the user barely moved,
 * so a single ordinary frame is saved instead of a sliver-wider "panorama".
 */
export const PANO_MIN_FRAMES = 3;

/** Upper bound on the composed image's width, to keep the raster affordable. */
export const PANO_MAX_OUTPUT_W = 6000;

/** Height each frame is rendered at while compositing. */
export const PANO_RENDER_H = 1440;

/**
 * Budget for the pixels decoded while composing: every source frame at render
 * size, plus the output raster (counted twice: the view-shot bitmap and its
 * JPEG encode buffer). Frames are downscaled until the sum fits.
 */
export const PANO_MAX_DECODED_BYTES = 120 * 1024 * 1024;

/** Capture cadence when no motion sensor is available to drive the sweep. */
export const PANO_FALLBACK_INTERVAL_MS = 700;

/**
 * A yaw jump larger than this between two sensor ticks is treated as noise (or
 * a compass wrap) rather than real motion, and ignored.
 */
export const PANO_MAX_PLAUSIBLE_STEP_DEG = 45;

/** Net rotation needed before the sweep direction is locked in. */
export const PANO_DIRECTION_LOCK_DEG = 3;

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
 * Fold a raw yaw reading into the running *signed* rotation since the sweep
 * started (positive = counter-clockwise seen from above, i.e. turning left).
 *
 * Returns the new position and whether the reading was used — an implausible
 * jump is dropped so a glitchy sensor can't race the sweep to completion.
 * `prevYaw` is null on the first reading, which only seeds the baseline.
 */
export function accumulateSweep(
  prevYaw: number | null,
  yaw: number,
  position: number,
): { position: number; accepted: boolean } {
  if (prevYaw == null) return { position, accepted: false };
  const d = angleDelta(prevYaw, yaw);
  if (Math.abs(d) > PANO_MAX_PLAUSIBLE_STEP_DEG) return { position, accepted: false };
  return { position: position + d, accepted: true };
}

/**
 * Which way the user is sweeping. Yaw positions follow the right-hand rule
 * about "up" (positive = turning left), so a positive net rotation means the
 * camera moved right-to-left and frames must be laid out in reverse.
 */
export type PanoDirection = "ltr" | "rtl";

export function directionFromPosition(position: number): PanoDirection | null {
  if (position >= PANO_DIRECTION_LOCK_DEG) return "rtl";
  if (position <= -PANO_DIRECTION_LOCK_DEG) return "ltr";
  return null;
}

export interface PanoFrameInput {
  width: number;
  height: number;
  /** Sweep progress (degrees, ≥ 0, non-decreasing) when the frame was taken. */
  angle: number;
}

export interface PanoSlice {
  /** Index into the input frame array. */
  frameIndex: number;
  /** Width of the strip this frame contributes (output px). */
  sliceW: number;
  /** Left offset of the full frame inside its strip (output px, ≤ 0). */
  offsetX: number;
}

export interface PanoLayout {
  /** Width each source frame is rendered at (output px). */
  frameW: number;
  /** Height each source frame is rendered at (also the output height). */
  frameH: number;
  /** Strips in left-to-right output order. */
  slices: PanoSlice[];
  outW: number;
  outH: number;
}

/**
 * Work out the offscreen composition's geometry.
 *
 * Frames are placed along the horizon at their measured angle (mirrored for a
 * right-to-left sweep, so the output always reads left-to-right). Each frame
 * owns the part of the scene closer to its centre than to its neighbours'; the
 * outermost frames also contribute their outer half. The whole row is then
 * scaled so its width stays under `maxOutW` and the decoded pixels under
 * `maxDecodedBytes`.
 */
export function panoLayout(opts: {
  frames: PanoFrameInput[];
  direction: PanoDirection;
  hfovDeg?: number;
  renderH?: number;
  maxOutW?: number;
  maxDecodedBytes?: number;
}): PanoLayout {
  const {
    frames,
    direction,
    renderH = PANO_RENDER_H,
    maxOutW = PANO_MAX_OUTPUT_W,
    maxDecodedBytes = PANO_MAX_DECODED_BYTES,
  } = opts;

  // Fall back to a sane portrait frame when the camera didn't report a size.
  const first = frames[0];
  const srcW = first && first.width > 0 ? first.width : 1080;
  const srcH = first && first.height > 0 ? first.height : 1440;
  const aspect = srcW / srcH;
  const hfov = opts.hfovDeg ?? estimateHfovDeg(srcW, srcH);

  // World positions, left → right. A right-to-left sweep turns the camera
  // left, so later frames sit further LEFT: mirror and reverse.
  const placed = frames.map((f, i) => ({
    i,
    x: direction === "rtl" ? -f.angle : f.angle,
  }));
  if (direction === "rtl") placed.reverse();
  // Drop frames that didn't advance past the last kept one (sensor stall /
  // duplicate angle) — they would only produce zero-width strips.
  const ordered: typeof placed = [];
  for (const p of placed) {
    if (ordered.length === 0 || p.x > ordered[ordered.length - 1]!.x + 0.25) ordered.push(p);
  }

  const half = hfov / 2;
  const ranges = ordered.map((p, k) => {
    const prev = ordered[k - 1];
    const next = ordered[k + 1];
    const left = prev ? Math.max(p.x - half, (prev.x + p.x) / 2) : p.x - half;
    const right = next ? Math.min(p.x + half, (p.x + next.x) / 2) : p.x + half;
    return { ...p, left, right };
  });
  const x0 = ranges[0]?.left ?? 0;

  const build = (h: number): PanoLayout => {
    const frameH = Math.max(1, Math.round(h));
    const frameW = Math.max(1, Math.round(frameH * aspect));
    const pxPerDeg = frameW / hfov;
    const slices: PanoSlice[] = [];
    let cursor = 0;
    for (const r of ranges) {
      // Cumulative rounding so strip widths never drift from the geometry.
      const end = Math.round((r.right - x0) * pxPerDeg);
      const sliceW = Math.max(1, Math.min(frameW, end - cursor));
      // Column of this strip's left edge inside its own frame.
      const leftInFrame = frameW / 2 + (r.left - r.x) * pxPerDeg;
      const offsetX = -Math.max(0, Math.min(frameW - sliceW, Math.round(leftInFrame)));
      slices.push({ frameIndex: r.i, sliceW, offsetX });
      cursor += sliceW;
    }
    return { frameW, frameH, slices, outW: Math.max(1, cursor), outH: frameH };
  };

  const baseH = Math.min(srcH, renderH);
  let layout = build(baseH);
  let scale = 1;
  if (layout.outW > maxOutW) scale = Math.min(scale, maxOutW / layout.outW);
  // Pixels scale with the square of the linear factor.
  const bytes = (layout.slices.length * layout.frameW * layout.frameH + 2 * layout.outW * layout.outH) * 4;
  if (bytes > maxDecodedBytes) scale = Math.min(scale, Math.sqrt(maxDecodedBytes / bytes));
  if (scale < 1) layout = build(baseH * scale);
  // Guard against an empty sweep so callers always get a drawable size.
  if (layout.slices.length === 0) {
    const w = Math.max(1, Math.round(baseH * aspect));
    return { frameW: w, frameH: Math.round(baseH), slices: [], outW: w, outH: Math.round(baseH) };
  }
  return layout;
}
