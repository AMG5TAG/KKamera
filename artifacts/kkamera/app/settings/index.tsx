import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useGetSubscription, useGetMe } from "@workspace/api-client-react";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

interface SettingRowProps {
  icon: string;
  iconSet?: "ion" | "mci";
  label: string;
  value?: string;
  badge?: string;
  onPress: () => void;
  hint?: string;
}

function SettingRow({ icon, iconSet = "ion", label, value, badge, onPress, hint }: SettingRowProps) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress}>
      <View style={styles.rowIcon}>
        {iconSet === "mci"
          ? <MaterialCommunityIcons name={icon as any} size={20} color={PRIMARY} />
          : <Ionicons name={icon as any} size={20} color={PRIMARY} />
        }
      </View>
      <View style={styles.rowContent}>
        <View style={styles.rowTop}>
          <Text style={styles.rowLabel}>{label}</Text>
          {badge && <View style={styles.badge}><Text style={styles.badgeText}>{badge}</Text></View>}
        </View>
        {hint && <Text style={styles.rowHint}>{hint}</Text>}
      </View>
      <View style={styles.rowRight}>
        {value && <Text style={styles.rowValue}>{value}</Text>}
        <Ionicons name="chevron-forward" size={16} color="#555" />
      </View>
    </TouchableOpacity>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const { data: sub } = useGetSubscription({ query: { enabled: !!user } });
  const { data: me } = useGetMe({ query: { enabled: !!user } });

  const subStatus = sub?.status ?? "none";
  const subLabel = subStatus === "trial" ? "14-Day Trial" : subStatus === "active" ? "Active ($25/yr)" : subStatus === "cancelled" ? "Cancelled" : "Not subscribed";

  const handleLogout = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: logout },
    ]);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 20) + 20 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Profile Card */}
      <View style={styles.profileCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(me?.name || user?.name || "?")[0]?.toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.profileName}>{me?.name || user?.name || "—"}</Text>
          <Text style={styles.profileEmail}>{me?.email || user?.email || "—"}</Text>
          <Text style={styles.profileCode}>Code: <Text style={{ color: PRIMARY, fontFamily: "Inter_600SemiBold" }}>{user?.referralCode || "—"}</Text></Text>
        </View>
      </View>

      <SectionHeader title="Storage" />
      <View style={styles.section}>
        <SettingRow icon="cloud-upload-outline" label="Cloud Storage" value="Manage" hint="? Connect FTP, WebDAV, Google Drive, OneDrive & Dropbox" onPress={() => router.push("/settings/cloud")} />
      </View>

      <SectionHeader title="Subscription" />
      <View style={styles.section}>
        <SettingRow icon="card-outline" label="My Subscription" value={subLabel} badge={subStatus === "trial" ? "TRIAL" : undefined} onPress={() => router.push("/settings/subscription")} />
        <SettingRow icon="people-outline" label="Refer & Earn" value="Free Years" hint="? Get 1 free year for every 5 friends you refer" onPress={() => router.push("/settings/affiliate")} />
      </View>

      <SectionHeader title="Account & Security" />
      <View style={styles.section}>
        <SettingRow icon="shield-checkmark-outline" label="Two-Factor Authentication" value={user?.twoFAEnabled ? "On" : "Off"} hint={user?.twoFAEnabled ? undefined : "? Recommended — protects your account"} onPress={() => router.push("/settings/security")} />
      </View>

      <SectionHeader title="App" />
      <View style={styles.section}>
        <SettingRow icon="bug-outline" label="Feedback & Bugs" hint="? Report issues or request features" onPress={() => router.push("/settings/feedback")} />
        <SettingRow icon="shield-half-outline" label="Privacy Policy" onPress={() => router.push("/settings/privacy")} />
        <SettingRow icon="document-text-outline" label="Terms of Service" onPress={() => router.push("/settings/terms")} />
      </View>

      <SectionHeader title="Version" />
      <View style={styles.section}>
        <View style={styles.versionRow}>
          <Text style={styles.versionText}>KKamera v1.0.0</Text>
          <Text style={styles.versionSub}>Cloud Based Photography</Text>
        </View>
      </View>

      <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
        <Ionicons name="log-out-outline" size={18} color="#ef4444" />
        <Text style={styles.logoutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  profileCard: { flexDirection: "row", alignItems: "center", gap: 14, margin: 16, backgroundColor: CARD, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)" },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: PRIMARY, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 22, fontFamily: "Inter_700Bold", color: "white" },
  profileName: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: "white", marginBottom: 2 },
  profileEmail: { fontSize: 13, color: "#888", fontFamily: "Inter_400Regular", marginBottom: 4 },
  profileCode: { fontSize: 12, color: "#666", fontFamily: "Inter_400Regular" },
  sectionHeader: { fontSize: 11, color: "#666", fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, textTransform: "uppercase", paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 },
  section: { marginHorizontal: 16, backgroundColor: CARD, borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.05)" },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.04)" },
  rowIcon: { width: 34, height: 34, borderRadius: 8, backgroundColor: "rgba(177,152,112,0.12)", alignItems: "center", justifyContent: "center", marginRight: 12 },
  rowContent: { flex: 1 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowLabel: { fontSize: 15, fontFamily: "Inter_500Medium", color: "white" },
  rowHint: { fontSize: 11, color: "#666", fontFamily: "Inter_400Regular", marginTop: 2 },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowValue: { fontSize: 13, color: "#888", fontFamily: "Inter_400Regular" },
  badge: { backgroundColor: "rgba(177,152,112,0.2)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  badgeText: { fontSize: 10, fontFamily: "Inter_600SemiBold", color: PRIMARY, letterSpacing: 0.5 },
  versionRow: { paddingHorizontal: 14, paddingVertical: 14 },
  versionText: { fontSize: 14, fontFamily: "Inter_500Medium", color: "#666" },
  versionSub: { fontSize: 12, color: "#444", fontFamily: "Inter_400Regular", marginTop: 2 },
  logoutBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginHorizontal: 16, marginTop: 24, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)" },
  logoutText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#ef4444" },
});
