import React, { useEffect, useRef, useState } from "react";
import { View, StyleSheet, Platform } from "react-native";
import * as Haptics from "expo-haptics";
import { getDeviceMotion, levelFromUp } from "./motion";

const PRIMARY = "#b19870";

// Tilt within this many degrees of horizontal counts as "level" → green guide.
export const LEVEL_TOLERANCE_DEG = 2;

/**
 * Spirit-level overlay. Owns its own motion subscription and state, so sensor
 * ticks re-render only this small view — never the camera screen.
 *
 * The whole guide turns with the way the phone is held (the UI is
 * portrait-locked), the tilt line follows the true horizon, and it snaps green
 * within LEVEL_TOLERANCE_DEG (with a light haptic tick on the snap).
 * `enabled` = the Level Guide setting; `active` = the camera is on screen.
 */
export const LevelGuide = React.memo(function LevelGuide({ enabled, active }: { enabled: boolean; active: boolean }) {
  const [levelRoll, setLevelRoll] = useState(0);
  const [levelBase, setLevelBase] = useState(0);
  const [levelFlat, setLevelFlat] = useState(false);
  const lastLevel = useRef({ roll: 0, base: 0, flat: false });

  useEffect(() => {
    const reset = () => {
      lastLevel.current = { roll: 0, base: 0, flat: false };
      setLevelRoll(0); setLevelBase(0); setLevelFlat(false);
    };
    if (!enabled) { reset(); return; }
    if (!active) return;

    // Low-pass the up vector so hand shake doesn't make the guide jitter.
    const up = { x: 0, y: 1, z: 0, seeded: false };
    const pushUp = (ux: number, uy: number, uz: number, screenAngle = 0) => {
      if (!up.seeded) { up.x = ux; up.y = uy; up.z = uz; up.seeded = true; }
      else {
        const k = 0.3;
        up.x += (ux - up.x) * k; up.y += (uy - up.y) * k; up.z += (uz - up.z) * k;
      }
      // Rotate into screen coordinates when the page itself has rotated (web).
      const a = (screenAngle * Math.PI) / 180;
      const sx = up.x * Math.cos(a) - up.y * Math.sin(a);
      const sy = up.x * Math.sin(a) + up.y * Math.cos(a);
      const lv = levelFromUp(sx, sy, up.z);
      const next = lv
        ? { roll: Math.round(lv.deviation), base: lv.base, flat: false }
        : { roll: 0, base: lastLevel.current.base, flat: true };
      // Only re-render on a real change — not on every sensor tick.
      const prev = lastLevel.current;
      if (next.roll === prev.roll && next.base === prev.base && next.flat === prev.flat) return;
      lastLevel.current = next;
      setLevelRoll(next.roll); setLevelBase(next.base); setLevelFlat(next.flat);
    };

    if (Platform.OS === "web") {
      // deviceorientation's beta/gamma (Z-X'-Y'' Euler angles) give the "up"
      // vector in device coordinates; unlike raw devicemotion, its signs are
      // consistent across browsers. The page rotates with the device on web,
      // so compensate for the current screen angle.
      const handler = (e: any) => {
        if (e?.beta == null || e?.gamma == null) return;
        const b = (e.beta * Math.PI) / 180;
        const g = (e.gamma * Math.PI) / 180;
        const w: any = typeof window !== "undefined" ? window : null;
        const screenAngle = Number(w?.screen?.orientation?.angle ?? w?.orientation ?? 0) || 0;
        pushUp(-Math.sin(g) * Math.cos(b), Math.sin(b), Math.cos(g) * Math.cos(b), screenAngle);
      };
      window.addEventListener("deviceorientation", handler);
      return () => window.removeEventListener("deviceorientation", handler);
    }

    let sub: { remove: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const DeviceMotion = await getDeviceMotion();
        if (!DeviceMotion || cancelled) return;
        const available = await DeviceMotion.isAvailableAsync().catch(() => false);
        if (!available || cancelled) return;
        // No requestPermissionsAsync here: on iOS it runs a CMPedometer query
        // and raises a "Motion & Fitness" prompt, yet CMMotionManager device
        // motion needs no authorisation (Android has no permission either).
        DeviceMotion.setUpdateInterval(60);
        const created = DeviceMotion.addListener(({ accelerationIncludingGravity: g }) => {
          // expo-sensors reports gravity pointing DOWN on both platforms (iOS
          // natively; Android as accel − 2·gravity), in device axes (x → right
          // edge, y → top edge). "Up" is its negation.
          if (!g) return;
          pushUp(-g.x, -g.y, -g.z);
        });
        if (cancelled) created.remove();
        else sub = created;
      } catch { /* sensor unavailable */ }
    })();
    return () => { cancelled = true; sub?.remove(); };
  }, [enabled, active]);

  // Give a light haptic tick the moment the guide snaps to level.
  const wasLevel = useRef(false);
  useEffect(() => {
    if (!enabled) { wasLevel.current = false; return; }
    const level = !levelFlat && Math.abs(levelRoll) <= LEVEL_TOLERANCE_DEG;
    if (level && !wasLevel.current && Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    wasLevel.current = level;
  }, [levelRoll, levelFlat, enabled]);

  if (!enabled) return null;
  const isLevel = Math.abs(levelRoll) <= LEVEL_TOLERANCE_DEG;
  return (
    <View style={[StyleSheet.absoluteFill, styles.levelContainer]} pointerEvents="none">
      {!levelFlat && (
        <>
          {/* Reference line — the held orientation's horizontal */}
          <View style={[
            styles.levelRefLine,
            { transform: [{ rotate: `${levelBase}deg` }] },
            isLevel && styles.levelRefLineActive,
          ]} />
          {/* Horizon line — rotates against the device's tilt */}
          <View style={[
            styles.levelLine,
            { transform: [{ rotate: `${levelBase + levelRoll}deg` }] },
            isLevel && styles.levelLineActive,
          ]} />
        </>
      )}
      <View style={[styles.levelDot, !levelFlat && isLevel && styles.levelDotActive]} />
    </View>
  );
});

const styles = StyleSheet.create({
  levelContainer: { alignItems: "center", justifyContent: "center" },
  levelRefLine: { width: "30%", height: 1, backgroundColor: "rgba(255,255,255,0.25)", position: "absolute" },
  levelRefLineActive: { backgroundColor: "rgba(34,197,94,0.6)" },
  levelLine: { width: "60%", height: 2, backgroundColor: "rgba(177,152,112,0.85)", position: "absolute" },
  levelLineActive: { backgroundColor: "#22c55e" },
  levelDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: PRIMARY },
  levelDotActive: { backgroundColor: "#22c55e" },
});
