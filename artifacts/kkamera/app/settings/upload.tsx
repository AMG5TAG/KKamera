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
      <View style={[styles.iconWrap, iconColor ? { backgroundColor: iconColor + "22" } : null]}>
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

export default function UploadScreen() {
  const insets = useSafeAreaInsets();
  const { settings, updateSetting } = useSettings();

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={24} color={PRIMARY} />
        <Text style={styles.backBtnText}>Back</Text>
      </TouchableOpacity>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.sectionLabel}>Destinations</Text>
        <View style={styles.card}>
          <SettingRow
            icon="cloud-upload-outline"
            label="Cloud Connections"
            hint="FTP, WebDAV, Google Drive, OneDrive, Dropbox"
            onPress={() => router.push("/settings/cloud")}
          />
        </View>

        <Text style={styles.sectionLabel}>History</Text>
        <View style={styles.card}>
          <SettingRow
            icon="time-outline"
            label="Upload History"
            hint="View and manage past uploads"
            onPress={() => router.push("/history")}
          />
        </View>

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
  backBtnText: { fontSize: 15, color: PRIMARY, fontFamily: "Inter_500Medium" },
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
});
