import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSettings, type GridType } from "@/contexts/SettingsContext";

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

function SegmentRow<T extends string | number>({
  icon, label, hint, options, value, onChange,
}: {
  icon: string; label: string; hint?: string;
  options: { label: string; value: T }[];
  value: T; onChange: (v: T) => void;
}) {
  return (
    <View style={[styles.row, { flexDirection: "column", alignItems: "flex-start", gap: 8 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={styles.iconWrap}>
          <Ionicons name={icon as any} size={19} color={PRIMARY} />
        </View>
        <View>
          <Text style={styles.rowLabel}>{label}</Text>
          {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
        </View>
      </View>
      <View style={styles.segmentWrap}>
        {options.map(opt => (
          <TouchableOpacity
            key={String(opt.value)}
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

        <SectionLabel title="Composition" />
        <View style={styles.card}>
          <SegmentRow<GridType>
            icon="grid-outline"
            label="Grid Overlay"
            hint="Choose a composition guide"
            options={[
              { label: "Off",       value: "off" },
              { label: "3×3",       value: "thirds" },
              { label: "Golden",    value: "golden" },
              { label: "Square",    value: "square" },
              { label: "Diagonal",  value: "diagonal" },
            ]}
            value={settings.gridType}
            onChange={v => updateSetting("gridType", v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="analytics-outline"
            label="Level Guide"
            hint="Horizon indicator for auto-level shots"
            value={settings.showLevelGuide}
            onToggle={v => updateSetting("showLevelGuide", v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="sync-outline"
            label="Upside-Down Preview"
            hint="Rotate preview 180° for attachable lenses"
            value={settings.flipPreview}
            onToggle={v => updateSetting("flipPreview", v)}
          />
        </View>

        <SectionLabel title="Shutter" />
        <View style={styles.card}>
          <SegmentRow<0 | 3 | 10>
            icon="timer-outline"
            label="Self-Timer"
            hint="Countdown before each shot"
            options={[
              { label: "Off",  value: 0 },
              { label: "3 s",  value: 3 },
              { label: "10 s", value: 10 },
            ]}
            value={settings.timerSeconds}
            onChange={v => updateSetting("timerSeconds", v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="volume-high-outline"
            label="Voice Countdown"
            hint="Speak the countdown out loud"
            value={settings.timerBeep}
            onToggle={v => updateSetting("timerBeep", v)}
          />
          <View style={styles.divider} />
          <SegmentRow<number>
            icon="albums-outline"
            label="Auto-Repeat (Burst)"
            hint="Take N photos automatically"
            options={[
              { label: "Off", value: 1 },
              { label: "3",   value: 3 },
              { label: "5",   value: 5 },
              { label: "10",  value: 10 },
            ]}
            value={settings.burstCount}
            onChange={v => updateSetting("burstCount", v)}
          />
          <View style={styles.divider} />
          <SegmentRow<number>
            icon="hourglass-outline"
            label="Burst Delay"
            options={[
              { label: "0.5 s", value: 0.5 },
              { label: "1 s",   value: 1 },
              { label: "2 s",   value: 2 },
              { label: "5 s",   value: 5 },
            ]}
            value={settings.burstDelay}
            onChange={v => updateSetting("burstDelay", v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="sunny-outline"
            label="Screen Flash (Selfie)"
            hint="White screen flash on front-camera shots"
            value={settings.screenFlashSelfie}
            onToggle={v => updateSetting("screenFlashSelfie", v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="hardware-chip-outline"
            label="Volume Keys Capture"
            hint="Use volume keys / spacebar as shutter (web)"
            value={settings.volumeKeyShutter}
            onToggle={v => updateSetting("volumeKeyShutter", v)}
          />
        </View>

        <SectionLabel title="Metadata & Stamps" />
        <View style={styles.card}>
          <ToggleRow
            icon="location-outline"
            label="Embed GPS in Photos"
            hint="Save GPS coordinates with the file"
            value={settings.saveLocation}
            onToggle={v => updateSetting("saveLocation", v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="compass-outline"
            label="Compass Direction"
            hint="Add bearing (GPSImgDirection) to GPS data"
            value={settings.compassMeta}
            onToggle={v => updateSetting("compassMeta", v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="calendar-outline"
            label="Date / Time / Location Stamp"
            hint="Apply a timestamp watermark to photos"
            value={settings.stampPhotos}
            onToggle={v => updateSetting("stampPhotos", v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="shield-checkmark-outline"
            label="Strip EXIF on Upload"
            hint="Remove camera/device metadata before sending"
            value={settings.stripExif}
            onToggle={v => updateSetting("stripExif", v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="phone-portrait-outline"
            label="Mirror Front Camera"
            value={settings.mirrorFrontCamera}
            onToggle={v => updateSetting("mirrorFrontCamera", v)}
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
