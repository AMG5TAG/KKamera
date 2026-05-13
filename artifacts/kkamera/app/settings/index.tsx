import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Switch, Alert, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useGetSubscription, useGetMe } from "@workspace/api-client-react";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";
const BORDER = "rgba(255,255,255,0.06)";

function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

function SettingRow({
  icon, iconSet = "ion", iconColor, label, value, badge, hint, onPress, destructive = false,
}: {
  icon: string; iconSet?: "ion" | "mci"; iconColor?: string; label: string;
  value?: string; badge?: string; hint?: string; onPress?: () => void; destructive?: boolean;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={onPress ? 0.65 : 1}>
      <View style={[styles.rowIconWrap, iconColor ? { backgroundColor: iconColor + "22" } : null]}>
        {iconSet === "mci"
          ? <MaterialCommunityIcons name={icon as any} size={19} color={iconColor ?? PRIMARY} />
          : <Ionicons name={icon as any} size={19} color={iconColor ?? PRIMARY} />
        }
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowLabel, destructive && { color: "#ef4444" }]}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <View style={styles.rowRight}>
        {value ? <Text style={styles.rowValue}>{value}</Text> : null}
        {badge ? <View style={styles.badge}><Text style={styles.badgeText}>{badge}</Text></View> : null}
        {onPress ? <Ionicons name="chevron-forward" size={15} color="#444" /> : null}
      </View>
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
      <View style={[styles.rowIconWrap, iconColor ? { backgroundColor: iconColor + "22" } : null]}>
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
  icon, iconColor, label, options, value, onChange,
}: {
  icon: string; iconColor?: string; label: string;
  options: { label: string; value: T }[]; value: T; onChange: (v: T) => void;
}) {
  return (
    <View style={[styles.row, { flexDirection: "column", alignItems: "flex-start", gap: 10 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={[styles.rowIconWrap, iconColor ? { backgroundColor: iconColor + "22" } : null]}>
          <Ionicons name={icon as any} size={19} color={iconColor ?? PRIMARY} />
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

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const { settings, updateSetting } = useSettings();
  const { data: sub } = useGetSubscription({ query: { enabled: !!user } });
  const { data: me } = useGetMe({ query: { enabled: !!user } });

  const subStatus = sub?.status ?? "none";
  const subLabel =
    subStatus === "trial" ? "14-Day Trial" :
    subStatus === "active" ? "Active · $25/yr" :
    subStatus === "cancelled" ? "Cancelled" : "Subscribe";
  const subBadge =
    subStatus === "trial" ? "TRIAL" :
    subStatus === "active" ? "ACTIVE" : undefined;

  const handleLogout = () => {
    if (Platform.OS === "web") {
      if (window.confirm("Sign out of KKamera?")) logout();
    } else {
      Alert.alert("Sign Out", "Are you sure you want to sign out?", [
        { text: "Cancel", style: "cancel" },
        { text: "Sign Out", style: "destructive", onPress: logout },
      ]);
    }
  };

  const displayName = me?.name || user?.name || "—";
  const displayEmail = me?.email || user?.email || "—";
  const initials = displayName.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Profile card */}
      <View style={styles.profileCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials || "?"}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.profileName}>{displayName}</Text>
          <Text style={styles.profileEmail}>{displayEmail}</Text>
          {user?.referralCode ? (
            <View style={styles.referralPill}>
              <Ionicons name="people-outline" size={12} color={PRIMARY} />
              <Text style={styles.referralPillText}>Code: {user.referralCode}</Text>
            </View>
          ) : null}
        </View>
        <TouchableOpacity style={styles.editBtn} onPress={() => router.push("/settings/subscription")}>
          <Ionicons name="card-outline" size={18} color={PRIMARY} />
        </TouchableOpacity>
      </View>

      {/* Camera */}
      <SectionHeader title="Camera" />
      <View style={styles.section}>
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
        <View style={styles.divider} />
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

      {/* Upload */}
      <SectionHeader title="Upload" />
      <View style={styles.section}>
        <SettingRow
          icon="cloud-upload-outline"
          label="Cloud Connections"
          hint="FTP, WebDAV, Google Drive, OneDrive, Dropbox"
          onPress={() => router.push("/settings/cloud")}
        />
        <View style={styles.divider} />
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

      {/* Subscription */}
      <SectionHeader title="Subscription" />
      <View style={styles.section}>
        <SettingRow
          icon="card-outline"
          label="My Plan"
          value={subLabel}
          badge={subBadge}
          onPress={() => router.push("/settings/subscription")}
        />
        <View style={styles.divider} />
        <SettingRow
          icon="people-outline"
          label="Refer & Earn"
          hint="5 referrals = 1 free year"
          onPress={() => router.push("/settings/affiliate")}
        />
      </View>

      {/* Security */}
      <SectionHeader title="Security" />
      <View style={styles.section}>
        <SettingRow
          icon="shield-checkmark-outline"
          iconColor={user?.twoFAEnabled ? "#22c55e" : undefined}
          label="Two-Factor Authentication"
          value={user?.twoFAEnabled ? "On" : "Off"}
          hint={!user?.twoFAEnabled ? "Recommended — protect your account" : undefined}
          onPress={() => router.push("/settings/security")}
        />
      </View>

      {/* App */}
      <SectionHeader title="Support" />
      <View style={styles.section}>
        <SettingRow
          icon="chatbubble-ellipses-outline"
          label="Feedback & Bug Reports"
          hint="Help us improve KKamera"
          onPress={() => router.push("/settings/feedback")}
        />
        <View style={styles.divider} />
        <SettingRow
          icon="shield-half-outline"
          label="Privacy Policy"
          onPress={() => router.push("/settings/privacy")}
        />
        <View style={styles.divider} />
        <SettingRow
          icon="document-text-outline"
          label="Terms of Service"
          onPress={() => router.push("/settings/terms")}
        />
      </View>

      {/* Version */}
      <View style={styles.versionWrap}>
        <Text style={styles.versionText}>KKamera v1.0.0</Text>
        <Text style={styles.versionSub}>Cloud Based Photography</Text>
      </View>

      {/* Sign Out */}
      <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout} activeOpacity={0.7}>
        <Ionicons name="log-out-outline" size={18} color="#ef4444" />
        <Text style={styles.logoutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  profileCard: {
    flexDirection: "row", alignItems: "center", gap: 14,
    margin: 16, backgroundColor: CARD, borderRadius: 18, padding: 16,
    borderWidth: 1, borderColor: "rgba(177,152,112,0.25)",
  },
  avatar: {
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: PRIMARY, alignItems: "center", justifyContent: "center",
  },
  avatarText: { fontSize: 20, fontFamily: "Inter_700Bold", color: "#0d0b08" },
  profileName: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white", marginBottom: 2 },
  profileEmail: { fontSize: 13, color: "#777", fontFamily: "Inter_400Regular", marginBottom: 6 },
  referralPill: {
    flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start",
    backgroundColor: "rgba(177,152,112,0.12)", paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 20, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)",
  },
  referralPillText: { fontSize: 11, color: PRIMARY, fontFamily: "Inter_500Medium" },
  editBtn: {
    width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(177,152,112,0.1)", borderWidth: 1, borderColor: "rgba(177,152,112,0.2)",
  },
  sectionHeader: {
    fontSize: 11, color: "#555", fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.5, textTransform: "uppercase",
    paddingHorizontal: 20, paddingTop: 22, paddingBottom: 8,
  },
  section: {
    marginHorizontal: 16, backgroundColor: CARD, borderRadius: 16,
    overflow: "hidden", borderWidth: 1, borderColor: BORDER,
  },
  divider: { height: 1, backgroundColor: BORDER, marginLeft: 56 },
  row: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 14, paddingVertical: 13, gap: 12,
  },
  rowIconWrap: {
    width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(177,152,112,0.12)", flexShrink: 0,
  },
  rowBody: { flex: 1 },
  rowLabel: { fontSize: 15, fontFamily: "Inter_500Medium", color: "white" },
  rowHint: { fontSize: 11, color: "#555", fontFamily: "Inter_400Regular", marginTop: 2 },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowValue: { fontSize: 13, color: "#777", fontFamily: "Inter_400Regular" },
  badge: {
    backgroundColor: "rgba(177,152,112,0.18)", paddingHorizontal: 8,
    paddingVertical: 2, borderRadius: 20,
  },
  badgeText: { fontSize: 10, fontFamily: "Inter_700Bold", color: PRIMARY, letterSpacing: 0.5 },
  segmentWrap: { flexDirection: "row", gap: 6, paddingLeft: 46, paddingBottom: 4, flexWrap: "wrap" },
  segmentBtn: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.05)", borderWidth: 1, borderColor: "rgba(255,255,255,0.08)",
  },
  segmentBtnActive: { backgroundColor: "rgba(177,152,112,0.2)", borderColor: PRIMARY },
  segmentText: { fontSize: 13, fontFamily: "Inter_500Medium", color: "#666" },
  segmentTextActive: { color: PRIMARY },
  versionWrap: { alignItems: "center", paddingTop: 28, paddingBottom: 4 },
  versionText: { fontSize: 13, color: "#444", fontFamily: "Inter_500Medium" },
  versionSub: { fontSize: 11, color: "#333", fontFamily: "Inter_400Regular", marginTop: 2 },
  logoutBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    marginHorizontal: 16, marginTop: 16, marginBottom: 8,
    paddingVertical: 14, borderRadius: 14,
    borderWidth: 1, borderColor: "rgba(239,68,68,0.3)",
    backgroundColor: "rgba(239,68,68,0.05)",
  },
  logoutText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#ef4444" },
});
