import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSettings } from "@/contexts/SettingsContext";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";
const BORDER = "rgba(255,255,255,0.06)";

function SectionLabel({ title }: { title: string }) {
  return <Text style={styles.sectionLabel}>{title}</Text>;
}

function ToggleRow({
  icon, iconColor, label, hint, value, onToggle,
}: {
  icon: string; iconColor?: string; label: string; hint?: string;
  value: boolean; onToggle: (v: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={[styles.iconWrap, iconColor ? { backgroundColor: iconColor + "22" } : null]}>
        <Ionicons name={icon as any} size={19} color={iconColor ?? PRIMARY} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ false: "#333", true: PRIMARY + "88" }}
        thumbColor={value ? PRIMARY : "#666"}
        ios_backgroundColor="#333"
      />
    </View>
  );
}

function SegmentRow<T extends string>({
  icon, label, options, value, onChange,
}: {
  icon: string; label: string;
  options: { label: string; value: T }[];
  value: T; onChange: (v: T) => void;
}) {
  return (
    <View style={[styles.row, { flexDirection: "column", alignItems: "flex-start", gap: 10 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={styles.iconWrap}>
          <Ionicons name={icon as any} size={19} color={PRIMARY} />
        </View>
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
      <View style={styles.segmentWrap}>
        {options.map(opt => (
          <TouchableOpacity
            key={opt.value}
            style={[styles.segmentBtn, value === opt.value && styles.segmentBtnActive]}
            onPress={() => onChange(opt.value)}
          >
            <Text style={[styles.segmentText, value === opt.value && styles.segmentTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export default function CameraScreen() {
  const insets = useSafeAreaInsets();
  const { settings, updateSetting } = useSettings();

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={24} color={PRIMARY} />
      </TouchableOpacity>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
      >
        <SectionLabel title="Format" />
        <View style={styles.card}>
          <SegmentRow
            icon="camera-outline"
            label="Photo Format"
            options={[
              { label: "JPEG", value: "jpeg" },
              { label: "HEIC", value: "heic" },
              { label: "PNG", value: "png" },
              { label: "WebP", value: "webp" },
            ]}
            value={settings.imageFormat}
            onChange={v => updateSetting("imageFormat", v)}
          />
          <View style={styles.divider} />
          <SegmentRow
            icon="videocam-outline"
            label="Video Format"
            options={[
              { label: "MP4", value: "mp4" },
              { label: "MOV", value: "mov" },
              { label: "HEVC", value: "hevc" },
            ]}
            value={settings.videoFormat}
            onChange={v => updateSetting("videoFormat", v)}
          />
          <View style={styles.divider} />
          <SegmentRow
            icon="film-outline"
            label="Video Quality"
            options={[
              { label: "720p", value: "720p" },
              { label: "1080p", value: "1080p" },
              { label: "4K", value: "4k" },
            ]}
            value={settings.videoQuality}
            onChange={v => updateSetting("videoQuality", v)}
          />
        </View>

        <SectionLabel title="Capture" />
        <View style={styles.card}>
          <ToggleRow
            icon="location-outline"
            label="Embed GPS in Photos"
            hint="Save location data in photo metadata"
            value={settings.saveLocation}
            onToggle={v => updateSetting("saveLocation", v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="phone-portrait-outline"
            label="Mirror Front Camera"
            value={settings.mirrorFrontCamera}
            onToggle={v => updateSetting("mirrorFrontCamera", v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="analytics-outline"
            label="Level Guide"
            hint="Show horizon guide while shooting"
            value={settings.showLevelGuide}
            onToggle={v => updateSetting("showLevelGuide", v)}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  sectionLabel: {
    fontSize: 11, color: "#555", fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.5, textTransform: "uppercase",
    paddingHorizontal: 4, paddingTop: 18, paddingBottom: 8,
  },
  card: {
    backgroundColor: CARD, borderRadius: 16,
    overflow: "hidden", borderWidth: 1, borderColor: BORDER,
  },
  divider: { height: 1, backgroundColor: BORDER, marginLeft: 56 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 13, gap: 12 },
  iconWrap: {
    width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(177,152,112,0.12)", flexShrink: 0,
  },
  rowBody: { flex: 1 },
  rowLabel: { fontSize: 15, fontFamily: "Inter_500Medium", color: "white" },
  rowHint: { fontSize: 11, color: "#555", fontFamily: "Inter_400Regular", marginTop: 2 },
  segmentWrap: { flexDirection: "row", gap: 6, paddingLeft: 46, paddingBottom: 4, flexWrap: "wrap" },
  segmentBtn: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.05)", borderWidth: 1, borderColor: "rgba(255,255,255,0.08)",
  },
  segmentBtnActive: { backgroundColor: "rgba(177,152,112,0.2)", borderColor: PRIMARY },
  segmentText: { fontSize: 13, fontFamily: "Inter_500Medium", color: "#666" },
  segmentTextActive: { color: PRIMARY },
});
