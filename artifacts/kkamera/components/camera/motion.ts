import { useEffect, useState } from "react";
import { Platform } from "react-native";

// Lazy import so expo-sensors is never loaded on web (import-time crash).
// DeviceMotion drives the level guide (gravity), the held-orientation readout
// that rotates the camera icons, and the panorama sweep (gyro rate projected
// onto gravity, falling back to rotation.alpha).
export async function getDeviceMotion() {
  if (Platform.OS === "web") return null;
  const { DeviceMotion } = await import("expo-sensors");
  return DeviceMotion;
}

/**
 * Spirit-level reading from an "up" vector in screen coordinates (x → right
 * edge, y → top edge; any unit). `roll` is how far the device is rotated
 * counter-clockwise from upright (degrees, -180..180). `base` snaps that to the
 * nearest held orientation — 0 portrait, ±90 landscape, 180 upside-down — and
 * `deviation` is the tilt away from it, which is what "level" is judged on.
 * Returns null when the phone is lying flat (gravity is ~perpendicular to the
 * screen), where a horizon angle is meaningless.
 */
export function levelFromUp(ux: number, uy: number, uz: number) {
  const planar = Math.hypot(ux, uy);
  if (planar < 0.35 * Math.hypot(ux, uy, uz)) return null;
  const roll = Math.atan2(ux, uy) * (180 / Math.PI);
  let base = Math.round(roll / 90) * 90;
  if (base === -180) base = 180;
  let deviation = roll - base;
  if (deviation > 180) deviation -= 360;
  if (deviation < -180) deviation += 360;
  return { roll, base, deviation };
}

/**
 * The way the phone is being held — 0 portrait, ±90 landscape, 180
 * upside-down — for rotating on-screen icons while the UI itself stays locked
 * to portrait. Re-renders only when the held orientation actually changes,
 * with hysteresis so it doesn't flicker around 45°. Always 0 on web (the page
 * rotates with the device there) and while `active` is false.
 */
export function useHeldOrientation(active: boolean): number {
  const [base, setBase] = useState(0);
  useEffect(() => {
    if (!active || Platform.OS === "web") return;
    let sub: { remove: () => void } | null = null;
    let cancelled = false;
    let current = 0;
    setBase(0);
    const up = { x: 0, y: 1, z: 0, seeded: false };
    (async () => {
      try {
        const DeviceMotion = await getDeviceMotion();
        if (!DeviceMotion || cancelled) return;
        const available = await DeviceMotion.isAvailableAsync().catch(() => false);
        if (!available || cancelled) return;
        // No setUpdateInterval: it is global to DeviceMotion, and the level
        // guide / panorama set the rate they need.
        const created = DeviceMotion.addListener(({ accelerationIncludingGravity: g }) => {
          if (!g) return;
          if (!up.seeded) { up.x = -g.x; up.y = -g.y; up.z = -g.z; up.seeded = true; }
          else {
            const k = 0.2;
            up.x += (-g.x - up.x) * k; up.y += (-g.y - up.y) * k; up.z += (-g.z - up.z) * k;
          }
          const lv = levelFromUp(up.x, up.y, up.z);
          if (!lv || lv.base === current) return; // flat: keep the last orientation
          // Only switch once the tilt is well past the 45° boundary.
          if (Math.abs(lv.deviation) > 30) return;
          current = lv.base;
          setBase(lv.base);
        });
        if (cancelled) created.remove();
        else sub = created;
      } catch { /* sensor unavailable — icons stay upright */ }
    })();
    return () => { cancelled = true; sub?.remove(); };
  }, [active]);
  return active ? base : 0;
}
