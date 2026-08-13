import React, { useState, useEffect } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCloudConnections, useGetUploadTarget, useSetUploadTarget,
  getGetUploadTargetQueryKey,
} from "@workspace/api-client-react";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";
const BORDER = "rgba(255,255,255,0.06)";

type Mode = "all" | "selected" | "none";

const ICONS: Record<string, { icon: string; color: string; set: "ion" | "mci" }> = {
  googledrive: { icon: "google-drive", color: "#4285F4", set: "mci" },
  onedrive: { icon: "microsoft-onedrive", color: "#0078D4", set: "mci" },
  dropbox: { icon: "dropbox", color: "#0061FF", set: "mci" },
  nextcloud: { icon: "cloud-outline", color: "#0082C9", set: "ion" },
  webdav: { icon: "server-outline", color: "#6B7280", set: "ion" },
  ftp: { icon: "folder-outline", color: "#8B5CF6", set: "ion" },
};

const MODE_OPTIONS: { key: Mode; icon: string; label: string; hint: string }[] = [
  { key: "all", icon: "cloud-done-outline", label: "All accounts", hint: "Upload every capture to all active connections" },
  { key: "selected", icon: "git-branch-outline", label: "Selected accounts", hint: "Only upload to the accounts you choose below" },
  { key: "none", icon: "cloud-offline-outline", label: "Don't upload", hint: "Capture only — keep photos on the device" },
];

export default function UploadDestinationsScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { data: connections, isLoading: connLoading } = useListCloudConnections();
  const { data: target, isLoading: targetLoading } = useGetUploadTarget();
  const setMutation = useSetUploadTarget();

  const [mode, setMode] = useState<Mode>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  // Seed local state from the server default once it loads.
  useEffect(() => {
    if (target && !hydrated) {
      setMode(target.mode as Mode);
      setSelected(new Set(target.connectionIds ?? []));
      setHydrated(true);
    }
  }, [target, hydrated]);

  const toggle = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    const connectionIds = mode === "selected" ? Array.from(selected) : [];
    try {
      await setMutation.mutateAsync({ data: { mode, connectionIds } });
      queryClient.invalidateQueries({ queryKey: getGetUploadTargetQueryKey() });
      router.back();
    } catch {
      // Surfaced by the button staying enabled; keep the user on-screen to retry.
    }
  };

  if (connLoading || targetLoading) {
    return <View style={styles.center}><ActivityIndicator color={PRIMARY} /></View>;
  }

  const activeConns = connections ?? [];
  const saveDisabled = setMutation.isPending || (mode === "selected" && selected.size === 0);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={24} color={PRIMARY} />
      </TouchableOpacity>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 100 }} showsVerticalScrollIndicator={false}>
        <Text style={styles.pageTitle}>Upload Destination</Text>
        <Text style={styles.pageSubtitle}>Choose where captures upload by default. This is saved to your account.</Text>

        <View style={styles.card}>
          {MODE_OPTIONS.map((opt, i) => (
            <React.Fragment key={opt.key}>
              {i > 0 && <View style={styles.divider} />}
              <TouchableOpacity style={styles.row} onPress={() => setMode(opt.key)} activeOpacity={0.7}>
                <View style={styles.iconWrap}>
                  <Ionicons name={opt.icon as any} size={19} color={PRIMARY} />
                </View>
                <View style={styles.rowBody}>
                  <Text style={styles.rowLabel}>{opt.label}</Text>
                  <Text style={styles.rowHint}>{opt.hint}</Text>
                </View>
                <Ionicons
                  name={mode === opt.key ? "radio-button-on" : "radio-button-off"}
                  size={22}
                  color={mode === opt.key ? PRIMARY : "#555"}
                />
              </TouchableOpacity>
            </React.Fragment>
          ))}
        </View>

        {mode === "selected" && (
          <>
            <Text style={styles.sectionLabel}>Accounts</Text>
            {activeConns.length === 0 ? (
              <Text style={styles.emptyText}>No connections yet. Add one first.</Text>
            ) : (
              <View style={styles.card}>
                {activeConns.map((c, i) => {
                  const cfg = ICONS[c.type] ?? { icon: "cloud-outline", color: PRIMARY, set: "ion" as const };
                  const on = selected.has(c.id);
                  return (
                    <React.Fragment key={c.id}>
                      {i > 0 && <View style={styles.divider} />}
                      <TouchableOpacity style={styles.row} onPress={() => toggle(c.id)} activeOpacity={0.7}>
                        <View style={[styles.iconWrap, { backgroundColor: cfg.color + "22" }]}>
                          {cfg.set === "mci"
                            ? <MaterialCommunityIcons name={cfg.icon as any} size={19} color={cfg.color} />
                            : <Ionicons name={cfg.icon as any} size={19} color={cfg.color} />}
                        </View>
                        <View style={styles.rowBody}>
                          <Text style={styles.rowLabel}>{c.name}</Text>
                          <Text style={styles.rowHint} numberOfLines={1}>
                            {c.accountLabel ? c.accountLabel : c.type.toUpperCase()}
                            {c.active ? "" : " · inactive"}
                          </Text>
                        </View>
                        <Ionicons name={on ? "checkbox" : "square-outline"} size={22} color={on ? PRIMARY : "#555"} />
                      </TouchableOpacity>
                    </React.Fragment>
                  );
                })}
              </View>
            )}
            {mode === "selected" && selected.size === 0 && (
              <Text style={styles.warnText}>Select at least one account, or choose “All” / “Don't upload”.</Text>
            )}
          </>
        )}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 24 : 12) }]}>
        <TouchableOpacity
          style={[styles.saveBtn, saveDisabled && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={saveDisabled}
        >
          {setMutation.isPending
            ? <ActivityIndicator color="white" />
            : <Text style={styles.saveText}>Save default</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  center: { flex: 1, backgroundColor: BG, alignItems: "center", justifyContent: "center" },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  pageTitle: { fontSize: 20, fontFamily: "Inter_700Bold", color: "white", marginBottom: 6, paddingHorizontal: 4 },
  pageSubtitle: { fontSize: 13, color: "#888", fontFamily: "Inter_400Regular", marginBottom: 16, paddingHorizontal: 4 },
  sectionLabel: {
    fontSize: 11, color: "#555", fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.5, textTransform: "uppercase",
    paddingHorizontal: 4, paddingTop: 20, paddingBottom: 8,
  },
  card: { backgroundColor: CARD, borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: BORDER },
  divider: { height: 1, backgroundColor: BORDER, marginLeft: 56 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 13, gap: 12 },
  iconWrap: {
    width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(177,152,112,0.12)", flexShrink: 0,
  },
  rowBody: { flex: 1 },
  rowLabel: { fontSize: 15, fontFamily: "Inter_500Medium", color: "white" },
  rowHint: { fontSize: 11, color: "#777", fontFamily: "Inter_400Regular", marginTop: 2 },
  emptyText: { fontSize: 13, color: "#666", fontFamily: "Inter_400Regular", paddingHorizontal: 6, paddingVertical: 12 },
  warnText: { fontSize: 12, color: "#f59e0b", fontFamily: "Inter_400Regular", paddingHorizontal: 6, paddingTop: 10 },
  footer: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    paddingHorizontal: 16, paddingTop: 12,
    backgroundColor: "#0d0b08ee", borderTopWidth: 1, borderTopColor: BORDER,
  },
  saveBtn: { backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  saveBtnDisabled: { opacity: 0.5 },
  saveText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
});
