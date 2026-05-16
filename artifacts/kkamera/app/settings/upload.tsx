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

function SettingRow({
  icon, iconColor, label, hint, onPress,
}: {
  icon: string; iconColor?: string; label: string; hint?: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.65}>
      <View style={[styles.iconWrap, { backgroundColor: (iconColor ?? PRIMARY) + "22" }]}>
        <Ionicons name={icon as any} size={19} color={iconColor ?? PRIMARY} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={15} color="#444" />
    </TouchableOpacity>
  );
}

function ToggleRow({
  icon, iconColor, label, hint, value, onToggle,
}: {
  icon: string; iconColor?: string; label: string; hint?: string;
  value: boolean; onToggle: (v: boolean) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={[styles.iconWrap, { backgroundColor: (iconColor ?? PRIMARY) + "22" }]}>
        <Ionicons name={icon as any} size={19} color={iconColor ?? PRIMARY} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ false: "#2a2720", true: PRIMARY }}
        thumbColor="white"
        ios_backgroundColor="#2a2720"
      />
    </View>
  );
}

function RadioRow({
  label, hint, selected, onPress,
}: {
  label: string; hint?: string; selected: boolean; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.65}>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <View style={[styles.radio, selected && styles.radioActive]}>
        {selected && <View style={styles.radioDot} />}
      </View>
    </TouchableOpacity>
  );
}

export default function UploadScreen() {
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
        {/* Destinations */}
        <Text style={styles.sectionLabel}>Destinations</Text>
        <View style={styles.card}>
          <SettingRow
            icon="cloud-upload-outline"
            label="Cloud Connections"
            hint="FTP, WebDAV, Google Drive, OneDrive, Dropbox"
            onPress={() => router.push("/settings/cloud")}
          />
        </View>

        {/* History */}
        <Text style={styles.sectionLabel}>History</Text>
        <View style={styles.card}>
          <ToggleRow
            icon="time-outline"
            label="Record Upload History"
            hint="Track and view past uploads"
            value={settings.recordHistory}
            onToggle={v => updateSetting("recordHistory", v)}
          />
          {settings.recordHistory && (
            <>
              <View style={styles.divider} />
              <SettingRow
                icon="list-outline"
                label="View Upload History"
                hint="Browse and manage past uploads"
                onPress={() => router.push("/history")}
              />
            </>
          )}
        </View>

        {/* Photo Markup */}
        <Text style={styles.sectionLabel}>Photo Markup</Text>
        <View style={styles.card}>
          <ToggleRow
            icon="pencil-outline"
            label="Enable Photo Markup"
            hint="Annotate photos before uploading"
            value={settings.photoMarkup}
            onToggle={v => updateSetting("photoMarkup", v)}
          />
          {settings.photoMarkup && (
            <>
              <View style={styles.divider} />
              <View style={styles.subSection}>
                <Text style={styles.subSectionTitle}>Upload Mode</Text>
                <RadioRow
                  label="Upload Both"
                  hint="Save original and marked-up version"
                  selected={settings.markupUploadMode === "both"}
                  onPress={() => updateSetting("markupUploadMode", "both")}
                />
                <View style={styles.divider} />
                <RadioRow
                  label="Marked Version Only"
                  hint="Only save the annotated version"
                  selected={settings.markupUploadMode === "marked"}
                  onPress={() => updateSetting("markupUploadMode", "marked")}
                />
                <View style={styles.divider} />
                <RadioRow
                  label="Original Only"
                  hint="Skip markup, upload original"
                  selected={settings.markupUploadMode === "original"}
                  onPress={() => updateSetting("markupUploadMode", "original")}
                />
              </View>
            </>
          )}
        </View>

        {/* Behaviour */}
        <Text style={styles.sectionLabel}>Behaviour</Text>
        <View style={styles.card}>
          <ToggleRow
            icon="wifi-outline"
            label="Wi-Fi Only"
            hint="Upload only when connected to Wi-Fi"
            value={settings.uploadOnlyOnWifi}
            onToggle={v => updateSetting("uploadOnlyOnWifi", v)}
          />
          <View style={styles.divider} />
          <ToggleRow
            icon="help-circle-outline"
            label="Confirm Before Upload"
            hint="Ask before each upload"
            value={settings.promptBeforeUpload}
            onToggle={v => updateSetting("promptBeforeUpload", v)}
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
  card: { backgroundColor: CARD, borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: BORDER },
  divider: { height: 1, backgroundColor: BORDER, marginLeft: 56 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 13, gap: 12 },
  iconWrap: {
    width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  },
  rowBody: { flex: 1 },
  rowLabel: { fontSize: 15, fontFamily: "Inter_500Medium", color: "white" },
  rowHint: { fontSize: 11, color: "#555", fontFamily: "Inter_400Regular", marginTop: 2 },
  subSection: { paddingLeft: 14 },
  subSectionTitle: {
    fontSize: 11, color: "#666", fontFamily: "Inter_600SemiBold",
    letterSpacing: 1, textTransform: "uppercase",
    paddingHorizontal: 0, paddingVertical: 10,
  },
  radio: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: "#444",
    alignItems: "center", justifyContent: "center",
  },
  radioActive: { borderColor: PRIMARY },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: PRIMARY },
});
