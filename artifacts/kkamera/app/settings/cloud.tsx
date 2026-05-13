import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Alert, Platform, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCloudConnections, useDeleteCloudConnection, useUpdateCloudConnection,
  useTestCloudConnection, getListCloudConnectionsQueryKey,
} from "@workspace/api-client-react";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

const ICONS: Record<string, { icon: string; color: string; set: "ion" | "mci" }> = {
  googledrive: { icon: "google-drive", color: "#4285F4", set: "mci" },
  onedrive: { icon: "microsoft-onedrive", color: "#0078D4", set: "mci" },
  dropbox: { icon: "dropbox", color: "#0061FF", set: "mci" },
  webdav: { icon: "server-outline", color: "#6B7280", set: "ion" },
  ftp: { icon: "folder-outline", color: "#8B5CF6", set: "ion" },
};

export default function CloudScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { data: connections, isLoading } = useListCloudConnections();
  const deleteMutation = useDeleteCloudConnection();
  const updateMutation = useUpdateCloudConnection();
  const testMutation = useTestCloudConnection();
  const [testing, setTesting] = useState<number | null>(null);

  const handleDelete = (id: number, name: string) => {
    Alert.alert("Remove Connection", `Remove "${name}"? This will stop uploads to this storage.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove", style: "destructive",
        onPress: async () => {
          await deleteMutation.mutateAsync({ id });
          queryClient.invalidateQueries({ queryKey: getListCloudConnectionsQueryKey() });
        },
      },
    ]);
  };

  const handleToggleActive = async (id: number, active: boolean) => {
    await updateMutation.mutateAsync({ id, data: { active: !active } });
    queryClient.invalidateQueries({ queryKey: getListCloudConnectionsQueryKey() });
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    try {
      const result = await testMutation.mutateAsync({ id });
      Alert.alert(result.success ? "Connection OK" : "Connection Failed", result.message);
    } catch {
      Alert.alert("Error", "Could not test connection");
    } finally {
      setTesting(null);
    }
  };

  if (isLoading) {
    return <View style={styles.center}><ActivityIndicator color={PRIMARY} /></View>;
  }

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 0) }]}>
      <FlatList
        data={connections ?? []}
        keyExtractor={item => String(item.id)}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListHeaderComponent={(
          <View>
            <View style={styles.infoBanner}>
              <Ionicons name="information-circle-outline" size={18} color={PRIMARY} />
              <Text style={styles.infoText}>? Enable multiple connections to upload to all simultaneously.</Text>
            </View>
            <TouchableOpacity style={styles.addBtn} onPress={() => router.push("/settings/add-cloud")}>
              <Ionicons name="add-circle-outline" size={20} color="white" />
              <Text style={styles.addText}>Add New Connection</Text>
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={(
          <View style={styles.emptyWrap}>
            <Ionicons name="cloud-outline" size={48} color="#333" />
            <Text style={styles.emptyTitle}>No connections yet</Text>
            <Text style={styles.emptyText}>Tap "Add New Connection" to connect your cloud storage or FTP server.</Text>
          </View>
        )}
        renderItem={({ item }) => {
          const cfg = ICONS[item.type] ?? { icon: "cloud-outline", color: PRIMARY, set: "ion" };
          return (
            <View style={[styles.card, !item.active && styles.cardInactive]}>
              <View style={styles.cardTop}>
                <View style={[styles.cardIcon, { backgroundColor: cfg.color + "22" }]}>
                  {cfg.set === "mci"
                    ? <MaterialCommunityIcons name={cfg.icon as any} size={24} color={cfg.color} />
                    : <Ionicons name={cfg.icon as any} size={24} color={cfg.color} />
                  }
                </View>
                <View style={styles.cardInfo}>
                  <Text style={styles.cardName}>{item.name}</Text>
                  <Text style={styles.cardType}>{item.type.toUpperCase()} · {item.uploadPath || "/"}</Text>
                </View>
                <TouchableOpacity onPress={() => handleToggleActive(item.id, item.active)} style={styles.toggleBtn}>
                  <Ionicons name={item.active ? "toggle" : "toggle-outline"} size={32} color={item.active ? PRIMARY : "#555"} />
                </TouchableOpacity>
              </View>
              <View style={styles.cardActions}>
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() => handleTest(item.id)}
                  disabled={testing === item.id}
                >
                  {testing === item.id
                    ? <ActivityIndicator size="small" color={PRIMARY} />
                    : <Ionicons name="checkmark-circle-outline" size={16} color={PRIMARY} />
                  }
                  <Text style={styles.actionText}>Test</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.actionBtn, styles.actionDelete]} onPress={() => handleDelete(item.id, item.name)}>
                  <Ionicons name="trash-outline" size={16} color="#ef4444" />
                  <Text style={[styles.actionText, { color: "#ef4444" }]}>Remove</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  center: { flex: 1, backgroundColor: BG, alignItems: "center", justifyContent: "center" },
  infoBanner: { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: "rgba(177,152,112,0.08)", borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: "rgba(177,152,112,0.2)" },
  infoText: { flex: 1, fontSize: 13, color: "#aaa", fontFamily: "Inter_400Regular", lineHeight: 18 },
  addBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, backgroundColor: PRIMARY, borderRadius: 14, paddingVertical: 14, marginBottom: 4 },
  addText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white" },
  emptyWrap: { alignItems: "center", paddingVertical: 48 },
  emptyTitle: { fontSize: 18, fontFamily: "Inter_600SemiBold", color: "#666", marginTop: 12, marginBottom: 8 },
  emptyText: { fontSize: 14, color: "#444", fontFamily: "Inter_400Regular", textAlign: "center", paddingHorizontal: 20 },
  card: { backgroundColor: CARD, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "rgba(177,152,112,0.15)" },
  cardInactive: { opacity: 0.55 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 },
  cardIcon: { width: 46, height: 46, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  cardInfo: { flex: 1 },
  cardName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "white", marginBottom: 2 },
  cardType: { fontSize: 11, color: "#888", fontFamily: "Inter_500Medium", letterSpacing: 0.5 },
  toggleBtn: { padding: 4 },
  cardActions: { flexDirection: "row", gap: 10, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)", paddingTop: 12 },
  actionBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 8, borderRadius: 10, backgroundColor: "rgba(177,152,112,0.1)" },
  actionDelete: { backgroundColor: "rgba(239,68,68,0.08)" },
  actionText: { fontSize: 13, fontFamily: "Inter_500Medium", color: PRIMARY },
});
