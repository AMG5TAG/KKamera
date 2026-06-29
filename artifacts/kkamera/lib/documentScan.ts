/**
 * Document scan post-processing for the web/PWA build (pure canvas, no deps).
 *
 * Pipeline: detect the paper boundary in the capture, perspective-correct the
 * quad to a flat rectangle (auto-crop + deskew), then run an adaptive local
 * threshold so the result reads as a crisp digital scan — even lighting,
 * white paper and dense, sharp text — rather than a photo.
 *
 * Detection: downscale → grayscale → blur → Otsu threshold → largest bright
 * connected component → quad corners from diagonal extremes. If no plausible
 * document is found, the full frame is kept and only contrast is enhanced.
 */

export interface ScanResult {
  uri: string;
  /** True when a document boundary was found and perspective-corrected. */
  cropped: boolean;
}

interface Pt { x: number; y: number }

const ANALYSIS_MAX_DIM = 600;   // px — detection runs on a downscaled copy
const SOURCE_MAX_DIM = 2400;    // px — cap warp source size to bound memory
const OUTPUT_MAX_DIM = 2000;    // px — cap output document size
const MIN_AREA_FRACTION = 0.15; // document must cover ≥15% of the frame

export async function processDocumentScan(dataUri: string): Promise<ScanResult> {
  if (typeof document === "undefined") return { uri: dataUri, cropped: false };
  try {
    const img = await loadImage(dataUri);

    // Draw the (size-capped) source frame once; both paths sample from it.
    const srcScale = Math.min(1, SOURCE_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    const src = drawToCanvas(img, Math.round(img.naturalWidth * srcScale), Math.round(img.naturalHeight * srcScale));

    const quad = detectDocumentQuad(img);
    const out = quad
      ? warpPerspective(src, quad.map(p => ({ x: p.x * srcScale, y: p.y * srcScale })) as [Pt, Pt, Pt, Pt])
      : src;
    enhanceScan(out);
    return { uri: out.toDataURL("image/jpeg", 0.92), cropped: !!quad };
  } catch {
    return { uri: dataUri, cropped: false };
  }
}

// ─── Image helpers ────────────────────────────────────────────────────────────

function loadImage(uri: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new (window as any).Image() as HTMLImageElement;
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = uri;
  });
}

function drawToCanvas(img: HTMLImageElement, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return canvas;
}

// ─── Document boundary detection ──────────────────────────────────────────────

/** Returns full-resolution corner coordinates [TL, TR, BR, BL], or null. */
function detectDocumentQuad(img: HTMLImageElement): [Pt, Pt, Pt, Pt] | null {
  const scale = Math.min(1, ANALYSIS_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const data = drawToCanvas(img, w, h).getContext("2d")!.getImageData(0, 0, w, h).data;

  // Grayscale + 3×3 box blur to suppress paper texture before thresholding
  let gray: Uint8Array = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = (data[i * 4]! * 77 + data[i * 4 + 1]! * 150 + data[i * 4 + 2]! * 29) >> 8;
  }
  gray = boxBlur(gray, w, h);

  const threshold = otsu(gray);
  const bright = new Uint8Array(w * h);
  let brightCount = 0;
  for (let i = 0; i < w * h; i++) {
    if (gray[i]! > threshold) { bright[i] = 1; brightCount++; }
  }
  // A nearly-all-dark frame has no separable document. A nearly-all-bright
  // frame is the common "page fills the viewfinder" case — keep it so the page
  // still gets cropped to its edges rather than left as a plain photo.
  const frac = brightCount / (w * h);
  if (frac > 0.998 || frac < MIN_AREA_FRACTION) return null;

  const comp = largestComponent(bright, w, h);
  if (!comp || comp.count < MIN_AREA_FRACTION * w * h) return null;

  const quad: [Pt, Pt, Pt, Pt] = [comp.tl, comp.tr, comp.br, comp.bl];

  // Reject degenerate / concave quads and ones with merged corners
  if (!isConvex(quad)) return null;
  const minSep = 0.15 * Math.hypot(w, h);
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!, b = quad[(i + 1) % 4]!;
    if (Math.hypot(a.x - b.x, a.y - b.y) < minSep) return null;
  }
  if (shoelaceArea(quad) < MIN_AREA_FRACTION * w * h) return null;

  return quad.map(p => ({ x: p.x / scale, y: p.y / scale })) as [Pt, Pt, Pt, Pt];
}

function boxBlur(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += src[yy * w + xx]!;
          n++;
        }
      }
      out[y * w + x] = (sum / n) | 0;
    }
  }
  return out;
}

function otsu(gray: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]!]!++;
  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]!;
  let sumB = 0, wB = 0, best = 0, bestT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = t; }
  }
  return bestT;
}

interface Component { count: number; tl: Pt; tr: Pt; br: Pt; bl: Pt }

/** Largest 4-connected bright component, with corners from diagonal extremes. */
function largestComponent(mask: Uint8Array, w: number, h: number): Component | null {
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best: Component | null = null;

  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || visited[start]) continue;
    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    let count = 0;
    // Diagonal extremes: TL=min(x+y), BR=max(x+y), TR=max(x−y), BL=min(x−y)
    let tl: Pt = { x: 0, y: 0 }, br: Pt = { x: 0, y: 0 }, tr: Pt = { x: 0, y: 0 }, bl: Pt = { x: 0, y: 0 };
    let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;

    while (top > 0) {
      const idx = stack[--top]!;
      const x = idx % w, y = (idx / w) | 0;
      count++;
      const sum = x + y, diff = x - y;
      if (sum < minSum) { minSum = sum; tl = { x, y }; }
      if (sum > maxSum) { maxSum = sum; br = { x, y }; }
      if (diff > maxDiff) { maxDiff = diff; tr = { x, y }; }
      if (diff < minDiff) { minDiff = diff; bl = { x, y }; }

      if (x > 0 && mask[idx - 1] && !visited[idx - 1]) { visited[idx - 1] = 1; stack[top++] = idx - 1; }
      if (x < w - 1 && mask[idx + 1] && !visited[idx + 1]) { visited[idx + 1] = 1; stack[top++] = idx + 1; }
      if (y > 0 && mask[idx - w] && !visited[idx - w]) { visited[idx - w] = 1; stack[top++] = idx - w; }
      if (y < h - 1 && mask[idx + w] && !visited[idx + w]) { visited[idx + w] = 1; stack[top++] = idx + w; }
    }
    if (!best || count > best.count) best = { count, tl, tr, br, bl };
  }
  return best;
}

function isConvex(quad: [Pt, Pt, Pt, Pt]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!, b = quad[(i + 1) % 4]!, c = quad[(i + 2) % 4]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const s = Math.sign(cross);
    if (s === 0) return false;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function shoelaceArea(quad: [Pt, Pt, Pt, Pt]): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!, b = quad[(i + 1) % 4]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

// ─── Perspective correction ───────────────────────────────────────────────────

/** Warp the source quad [TL, TR, BR, BL] onto a flat upright rectangle. */
function warpPerspective(src: HTMLCanvasElement, quad: [Pt, Pt, Pt, Pt]): HTMLCanvasElement {
  const [p0, p1, p2, p3] = quad;
  const edge = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  let outW = Math.round(Math.max(edge(p0, p1), edge(p3, p2)));
  let outH = Math.round(Math.max(edge(p0, p3), edge(p1, p2)));
  const cap = OUTPUT_MAX_DIM / Math.max(outW, outH);
  if (cap < 1) { outW = Math.round(outW * cap); outH = Math.round(outH * cap); }
  outW = Math.max(1, outW);
  outH = Math.max(1, outH);

  // Projective map from the unit square to the source quad (closed form)
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0, hCoef = 0;
  if (sx !== 0 || sy !== 0) {
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x;
    const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    hCoef = (dx1 * sy - sx * dy1) / den;
  }
  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + hCoef * p3.x;
  const c = p0.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + hCoef * p3.y;
  const f = p0.y;

  const sw = src.width, sh = src.height;
  const srcData = src.getContext("2d")!.getImageData(0, 0, sw, sh).data;
  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const outCtx = out.getContext("2d")!;
  const outImg = outCtx.createImageData(outW, outH);
  const dst = outImg.data;

  for (let oy = 0; oy < outH; oy++) {
    const v = oy / (outH - 1 || 1);
    for (let ox = 0; ox < outW; ox++) {
      const u = ox / (outW - 1 || 1);
      const denom = g * u + hCoef * v + 1;
      const x = (a * u + b * v + c) / denom;
      const y = (d * u + e * v + f) / denom;

      // Bilinear sample with clamped borders
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(x)));
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(y)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, x - x0));
      const fy = Math.max(0, Math.min(1, y - y0));
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const o = (oy * outW + ox) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const topV = srcData[i00 + ch]! * (1 - fx) + srcData[i10 + ch]! * fx;
        const botV = srcData[i01 + ch]! * (1 - fx) + srcData[i11 + ch]! * fx;
        dst[o + ch] = (topV * (1 - fy) + botV * fy) | 0;
      }
      dst[o + 3] = 255;
    }
  }
  outCtx.putImageData(outImg, 0, 0);
  return out;
}

// ─── Scan enhancement ─────────────────────────────────────────────────────────

/**
 * Adaptive local-threshold "scan" enhancement. Each pixel is compared to the
 * average brightness of its neighbourhood rather than a single global cutoff,
 * which removes uneven lighting/shadows, whitens the paper and pushes text to
 * solid, dense black while keeping anti-aliased edges smooth. Colour is kept by
 * scaling RGB with the per-pixel luminance gain, so coloured ink/stamps survive.
 */
function enhanceScan(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width, h = canvas.height, n = w * h;
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // Per-pixel luminance.
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lum[i] = (data[i * 4]! * 77 + data[i * 4 + 1]! * 150 + data[i * 4 + 2]! * 29) / 256;
  }

  // Summed-area table of luminance → O(1) local means.
  const iw = w + 1;
  const integral = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += lum[y * w + x]!;
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
    }
  }
  const r = Math.max(8, Math.round(Math.min(w, h) * 0.06)); // local window radius
  const localMean = (x: number, y: number): number => {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r);
    const x1 = Math.min(w - 1, x + r), y1 = Math.min(h - 1, y + r);
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    const s = integral[(y1 + 1) * iw + (x1 + 1)]!
            - integral[y0 * iw + (x1 + 1)]!
            - integral[(y1 + 1) * iw + x0]!
            + integral[y0 * iw + x0]!;
    return s / area;
  };

  // Map a pixel's brightness relative to its local background onto [0,1]:
  // ≤ T_LOW of the background → solid ink, ≥ T_HIGH → clean white paper, with a
  // smooth ramp between so strokes stay sharp without jaggies. Lowering T_LOW or
  // the gamma thickens text ("font density").
  const T_LOW = 0.6, T_HIGH = 0.95, RANGE = T_HIGH - T_LOW;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const bg = Math.max(1, localMean(x, y));
      let t = (lum[i]! / bg - T_LOW) / RANGE;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const target = Math.pow(t, 0.7) * 255;
      const gain = target / Math.max(1, lum[i]!);
      const o = i * 4;
      data[o]     = Math.min(255, data[o]! * gain);
      data[o + 1] = Math.min(255, data[o + 1]! * gain);
      data[o + 2] = Math.min(255, data[o + 2]! * gain);
    }
  }
  ctx.putImageData(imgData, 0, 0);
}
