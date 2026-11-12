import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Platform, Animated, Easing } from "react-native";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";

const PRIMARY = "#b19870";
/** Cap Dynamic Type on camera overlay text so it can't overflow the chrome. */
export const OVERLAY_MAX_FONT_SCALE = 1.3;

export type HeadingReading = { deg: number; ref: "T" | "M" };

const formatTime = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

/**
 * Recording timer pill. Owns its once-a-second tick so the camera screen
 * doesn't re-render every second while recording. Counts from 0 each time
 * `active` turns on.
 */
export const RecordingBadge = React.memo(function RecordingBadge({ active }: { active: boolean }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!active) return;
    const t = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!active) return null;
  return (
    <View style={styles.recordingBadge} accessible accessibilityLabel={`Recording, ${formatTime(seconds)}`}>
      <View style={styles.recordingDot} />
      <Text style={styles.recordingTime} maxFontSizeMultiplier={OVERLAY_MAX_FONT_SCALE}>{formatTime(seconds)}</Text>
    </View>
  );
});

/**
 * Compass bearing badge (and the source of the bearing used for the stamp and
 * GPSImgDirection, written to `headingRef`). Location's heading API fuses
 * magnetometer + gyro and gives a true-north heading when a fix is available —
 * unlike a raw magnetometer atan2, which ignores tilt and declination. The
 * subscription and its per-degree updates stay inside this component.
 */
export const HeadingBadge = React.memo(function HeadingBadge({
  enabled, active, locationGranted, headingRef,
}: {
  enabled: boolean;
  active: boolean;
  /** Re-subscribes once location is granted (true-north needs a fix). */
  locationGranted: boolean | null;
  headingRef: React.MutableRefObject<HeadingReading | null>;
}) {
  const [heading, setHeading] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || Platform.OS === "web") { setHeading(null); headingRef.current = null; return; }
    if (!active) return;
    let sub: { remove: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const created = await Location.watchHeadingAsync(h => {
          const isTrue = h.trueHeading != null && h.trueHeading >= 0;
          const deg = isTrue ? h.trueHeading : h.magHeading;
          if (deg == null || deg < 0) return;
          headingRef.current = { deg, ref: isTrue ? "T" : "M" };
          const rounded = Math.round(deg) % 360;
          setHeading(prev => (prev === rounded ? prev : rounded));
        });
        if (cancelled) created.remove();
        else sub = created;
      } catch { /* no compass on this device */ }
    })();
    return () => { cancelled = true; sub?.remove(); };
  }, [enabled, locationGranted, active, headingRef]);

  if (heading == null) return null;
  return (
    <View style={styles.compassBadge} pointerEvents="none">
      <Ionicons name="compass-outline" size={13} color={PRIMARY} />
      <Text style={styles.compassText} maxFontSizeMultiplier={OVERLAY_MAX_FONT_SCALE}>{heading}°</Text>
    </View>
  );
});

/** Rounded whole-degree bearing for stamps, or null when there's no reading. */
export function headingDegrees(ref: React.MutableRefObject<HeadingReading | null>): number | null {
  const h = ref.current;
  return h ? Math.round(h.deg) % 360 : null;
}

/**
 * Animated rotation that keeps icons upright for the held orientation
 * (`base`: 0 portrait, ±90 landscape, 180 upside-down). Always turns the short
 * way round (e.g. 90 → 180 is +90°, not −270°).
 */
export function useIconRotation(base: number) {
  const anim = useRef(new Animated.Value(0)).current;
  const current = useRef(0);
  useEffect(() => {
    let delta = (base - current.current) % 360;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    if (delta === 0) return;
    current.current += delta;
    Animated.timing(anim, {
      toValue: current.current,
      duration: 220,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [base, anim]);
  return anim.interpolate({ inputRange: [-360, 360], outputRange: ["-360deg", "360deg"], extrapolate: "extend" });
}

const styles = StyleSheet.create({
  recordingBadge: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
  },
  recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#ef4444" },
  recordingTime: { color: "white", fontSize: 13, fontFamily: "Inter_500Medium" },
  compassBadge: {
    position: "absolute", top: 12, alignSelf: "center",
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 9, paddingVertical: 3, borderRadius: 11,
    backgroundColor: "rgba(0,0,0,0.55)", borderWidth: 1, borderColor: "rgba(177,152,112,0.35)",
  },
  compassText: { color: PRIMARY, fontSize: 11, fontFamily: "Inter_600SemiBold" },
});
