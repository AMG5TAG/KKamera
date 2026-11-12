import React from "react";
import { Path } from "react-native-svg";

/** A stroke, in IMAGE pixel coordinates (independent of the screen). */
export interface DrawnPath {
  d: string;
  color: string;
  width: number;
}

/**
 * The committed strokes. Memoised on the `paths` array, so a pan update (which
 * only changes the live stroke) never re-renders the finished ones.
 */
export const CommittedStrokes = React.memo(function CommittedStrokes({ paths }: { paths: DrawnPath[] }) {
  return (
    <>
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
    </>
  );
});

/**
 * SVG path for an arrow from (x1,y1) to (x2,y2) in image px: the shaft plus a
 * two-stroke head at the tip, sized from the stroke width.
 */
export function arrowPath(x1: number, y1: number, x2: number, y2: number, strokeW: number): string {
  const f = (n: number) => n.toFixed(1);
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 0.5) return `M${f(x1)},${f(y1)} L${f(x2)},${f(y2)}`;
  const head = Math.min(len * 0.6, Math.max(strokeW * 4, len * 0.12));
  const a = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  const hx1 = x2 - head * Math.cos(a - spread);
  const hy1 = y2 - head * Math.sin(a - spread);
  const hx2 = x2 - head * Math.cos(a + spread);
  const hy2 = y2 - head * Math.sin(a + spread);
  return `M${f(x1)},${f(y1)} L${f(x2)},${f(y2)} M${f(hx1)},${f(hy1)} L${f(x2)},${f(y2)} L${f(hx2)},${f(hy2)}`;
}
