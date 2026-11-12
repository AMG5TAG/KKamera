import React, { useEffect, useState } from "react";
import { TouchableOpacity, Image, StyleSheet, View, Animated } from "react-native";
import { Ionicons } from "@expo/vector-icons";

export interface LastCapture {
  /** A private preview copy (photos) — never the file handed to the upload queue. */
  uri: string | null;
  type: "image" | "video";
  /** The name the capture was uploaded under (the marked copy derives from it). */
  fileName: string;
}

/**
 * Small preview of the most recent capture, next to the shutter. Photos open
 * in the markup screen (to annotate and upload a marked copy); videos just
 * show an icon. Hides itself if the preview file is gone.
 */
export const LastCaptureThumb = React.memo(function LastCaptureThumb({
  capture, onPress, disabled, rotate,
}: {
  capture: LastCapture | null;
  onPress: () => void;
  disabled: boolean;
  rotate?: Animated.AnimatedInterpolation<string>;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [capture?.uri]);

  if (!capture || (capture.type === "image" && (!capture.uri || broken))) {
    // Keep the slot so the shutter row layout doesn't shift.
    return <View style={styles.slot} />;
  }
  const isPhoto = capture.type === "image";
  return (
    <TouchableOpacity
      style={styles.slot}
      onPress={onPress}
      disabled={disabled || !isPhoto}
      accessibilityRole="button"
      accessibilityLabel={isPhoto ? "Last photo" : "Last capture was a video"}
      accessibilityHint={isPhoto ? "Opens it in markup to annotate" : undefined}
      accessibilityState={{ disabled: disabled || !isPhoto }}
    >
      <Animated.View style={[styles.thumb, disabled && { opacity: 0.4 }, rotate ? { transform: [{ rotate }] } : null]}>
        {isPhoto ? (
          <Image source={{ uri: capture.uri! }} style={styles.img} onError={() => setBroken(true)} fadeDuration={0} />
        ) : (
          <Ionicons name="videocam" size={18} color="white" accessible={false} />
        )}
      </Animated.View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  slot: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  thumb: {
    width: 40, height: 40, borderRadius: 8, overflow: "hidden",
    borderWidth: 1.5, borderColor: "rgba(255,255,255,0.75)",
    backgroundColor: "#1a1710", alignItems: "center", justifyContent: "center",
  },
  img: { width: "100%", height: "100%" },
});
