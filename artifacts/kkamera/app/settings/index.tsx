import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useGetSubscription, useGetMe } from "@workspace/api-client-react";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";
const BORDER = "rgba(255,255,255,0.06)";

function MenuRow({
  icon, iconSet = "ion", iconColor, label, hint, badge, value, onPress,
}: {
  icon: string; iconSet?: "ion" | "mci"; iconColor?: string;
  label: string; hint?: string; badge?: string; value?: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.65}>
      <View style={[styles.rowIconWrap, iconColor ? { backgroundColor: iconColor + "22" } : null]}>
        {iconSet === "mci"
          ? <MaterialCommunityIcons name={icon as any} size={19} color={iconColor ?? PRIMARY} />
          : <Ionicons name={icon as any} size={19} color={iconColor ?? PRIMARY} />
        }
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <View style={styles.rowRight}>
        {value ? <Text style={styles.rowValue}>{value}</Text> : null}
        {badge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        ) : null}
        <Ionicons name="chevron-forward" size={15} color="#444" />
      </View>
    </TouchableOpacity>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const { data: sub } = useGetSubscription({ query: { enabled: !!user, queryKey: [] as any } });
  const { data: me } = useGetMe({ query: { enabled: !!user, queryKey: [] as any } });

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
    <View style={styles.container}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={24} color={PRIMARY} />
        <Text style={styles.backBtnText}>Back</Text>
      </TouchableOpacity>

      <ScrollView
        style={{ flex: 1 }}
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

        {/* Menu sections */}
        <View style={styles.section}>
          <MenuRow
            icon="camera-outline"
            label="Camera"
            hint="Format, quality, GPS, mirror"
            onPress={() => router.push("/settings/camera")}
          />
          <View style={styles.divider} />
          <MenuRow
            icon="cloud-upload-outline"
            label="Upload"
            hint="Cloud connections, Wi-Fi, queue"
            onPress={() => router.push("/settings/upload")}
          />
        </View>

        <View style={styles.section}>
          <MenuRow
            icon="card-outline"
            label="Subscription"
            hint="Plan, billing & referrals"
            value={subLabel}
            badge={subBadge}
            onPress={() => router.push("/settings/subscription")}
          />
          <View style={styles.divider} />
          <MenuRow
            icon="shield-checkmark-outline"
            iconColor={user?.twoFAEnabled ? "#22c55e" : undefined}
            label="Security"
            hint="Two-factor authentication"
            value={user?.twoFAEnabled ? "2FA On" : "2FA Off"}
            onPress={() => router.push("/settings/security")}
          />
        </View>

        <View style={styles.section}>
          <MenuRow
            icon="chatbubble-ellipses-outline"
            label="Support"
            hint="Feedback, privacy & terms"
            onPress={() => router.push("/settings/support")}
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  backBtnText: { fontSize: 15, color: PRIMARY, fontFamily: "Inter_500Medium" },
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
  section: {
    marginHorizontal: 16, marginBottom: 16, backgroundColor: CARD,
    borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: BORDER,
  },
  divider: { height: 1, backgroundColor: BORDER, marginLeft: 56 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 13, gap: 12 },
  rowIconWrap: {
    width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(177,152,112,0.12)", flexShrink: 0,
  },
  rowBody: { flex: 1 },
  rowLabel: { fontSize: 15, fontFamily: "Inter_500Medium", color: "white" },
  rowHint: { fontSize: 11, color: "#555", fontFamily: "Inter_400Regular", marginTop: 2 },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowValue: { fontSize: 13, color: "#777", fontFamily: "Inter_400Regular" },
  badge: { backgroundColor: "rgba(177,152,112,0.18)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20 },
  badgeText: { fontSize: 10, fontFamily: "Inter_700Bold", color: PRIMARY, letterSpacing: 0.5 },
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
