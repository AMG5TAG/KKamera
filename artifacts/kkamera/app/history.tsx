import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList,
  Alert, ActivityIndicator, RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListUploads, useDeleteUpload, useClearUploads, getListUploadsQueryKey,
} from "@workspace/api-client-react";
import { useSettings } from "@/contexts/SettingsContext";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

type UploadStatus = "pending" | "uploading" | "done" | "failed" | "queued" | "partial";

const STATUS_CONFIG: Record<UploadStatus, { color: string; icon: string; label: string }> = {
  done:      { color: "#22c55e", icon: "cloud-done-outline",       label: "Uploaded"   },
  uploading: { color: PRIMARY,   icon: "cloud-upload-outline",     label: "Uploading…" },
  partial:   { color: "#f59e0b", icon: "cloud-outline",            label: "Partial"    },
  failed:    { color: "#ef4444", icon: "cloud-offline-outline",    label: "Failed"     },
  queued:    { color: "#6b7280", icon: "time-outline",             label: "Queued"     },
  pending:   { color: "#6b7280", icon: "ellipsis-horizontal-outline", label: "Pending" },
};

function formatDate(iso: string) {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fileIcon(fileType: string, fileName: string) {
  if (fileType === "video") return "videocam-outline";
  if (fileName.startsWith("SCAN_")) return "document-text-outline";
  return "image-outline";
}

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { settings } = useSettings();
  const { data: uploads, isLoading, refetch, isRefetching } = useListUploads();
  const deleteMutation = useDeleteUpload();
  const clearMutation = useClearUploads();
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [isClearing, setIsClearing] = useState(false);

  const sorted = [...(uploads ?? [])].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const handleDelete = (id: number, fileName: string) => {
    Alert.alert("Remove Record", `Remove "${fileName}" from history?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove", style: "destructive",
        onPress: async () => {
          setDeletingId(id);
          try {
            await deleteMutation.mutateAsync({ id });
            queryClient.invalidateQueries({ queryKey: getListUploadsQueryKey() });
          } catch { Alert.alert("Error", "Could not remove record."); }
          finally { setDeletingId(null); }
        },
      },
    ]);
  };

  const handleClearAll = useCallback(() => {
    if (sorted.length === 0) return;
    Alert.alert(
      "Clear All History",
      `This will permanently delete all ${sorted.length} upload records. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear All", style: "destructive",
          onPress: async () => {
            setIsClearing(true);
            try {
              await clearMutation.mutateAsync();
              // Scrub the cached list immediately, then revalidate against the server
              queryClient.setQueryData(getListUploadsQueryKey(), []);
              queryClient.invalidateQueries({ queryKey: getListUploadsQueryKey() });
            } catch { Alert.alert("Error", "Could not clear history."); }
            finally { setIsClearing(false); }
          },
        },
      ]
    );
  }, [sorted.length, queryClient, clearMutation]);

  if (!settings.recordHistory) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color={PRIMARY} />
        </TouchableOpacity>
        <View style={styles.center}>
          <Ionicons name="eye-off-outline" size={48} color="#333" />
          <Text style={styles.emptyTitle}>History is disabled</Text>
          <Text style={styles.emptyText}>
            Enable "Record History" in Settings → Upload to start tracking uploads.
          </Text>
          <TouchableOpacity style={styles.settingsBtn} onPress={() => router.push("/settings/upload" as any)}>
            <Text style={styles.settingsBtnText}>Open Upload Settings</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const renderItem = ({ item }: { item: NonNullable<typeof uploads>[0] }) => {
    const status = (item.status ?? "pending") as UploadStatus;
    const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
    const isDeleting = deletingId === item.id;

    return (
      <View style={[styles.card, isDeleting && { opacity: 0.5 }]}>
        <View style={[styles.typeIcon, { backgroundColor: cfg.color + "22" }]}>
          <Ionicons name={fileIcon(item.fileType, item.fileName) as any} size={20} color={cfg.color} />
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.fileName} numberOfLines={1}>{item.fileName}</Text>
          <View style={styles.metaRow}>
            <Ionicons name={cfg.icon as any} size={12} color={cfg.color} />
            <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
            <Text style={styles.dotSep}>·</Text>
            <Text style={styles.dateText}>{formatDate(item.createdAt)}</Text>
          </View>
          {item.error && status === "failed" && (
            <Text style={styles.errorText} numberOfLines={2}>{item.error}</Text>
          )}
        </View>
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={() => handleDelete(item.id, item.fileName)}
          disabled={isDeleting}
        >
          {isDeleting
            ? <ActivityIndicator size="small" color="#ef4444" />
            : <Ionicons name="trash-outline" size={18} color="#ef4444" />
          }
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color={PRIMARY} />
        </TouchableOpacity>
        <Text style={styles.heading}>Upload History</Text>
        {sorted.length > 0 && (
          <TouchableOpacity onPress={handleClearAll} disabled={isClearing} style={styles.clearAllBtn}>
            {isClearing
              ? <ActivityIndicator size="small" color="#ef4444" />
              : (
                <>
                  <Ionicons name="trash-outline" size={15} color="#ef4444" />
                  <Text style={styles.clearAllText}>Clear</Text>
                </>
              )
            }
          </TouchableOpacity>
        )}
      </View>

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator color={PRIMARY} /></View>
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={item => String(item.id)}
          contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={PRIMARY} />}
          ListHeaderComponent={sorted.length > 0 ? (
            <Text style={styles.countText}>{sorted.length} record{sorted.length !== 1 ? "s" : ""}</Text>
          ) : null}
          ListEmptyComponent={(
            <View style={styles.emptyWrap}>
              <Ionicons name="cloud-upload-outline" size={52} color="#333" />
              <Text style={styles.emptyTitle}>No uploads yet</Text>
              <Text style={styles.emptyText}>Photos, videos, and scans you upload will appear here.</Text>
              <TouchableOpacity style={styles.cameraBtn} onPress={() => router.replace("/camera" as any)}>
                <Ionicons name="camera-outline" size={18} color="white" />
                <Text style={styles.cameraBtnText}>Open Camera</Text>
              </TouchableOpacity>
            </View>
          )}
          renderItem={renderItem}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  headerRow: {
    flexDirection: "row", alignItems: "center", paddingRight: 12, minHeight: 52,
  },
  backBtn: { padding: 12 },
  heading: { flex: 1, fontSize: 22, fontFamily: "Inter_700Bold", color: "white", paddingLeft: 4 },
  clearAllBtn: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 10, borderWidth: 1, borderColor: "rgba(239,68,68,0.35)",
  },
  clearAllText: { fontSize: 13, color: "#ef4444", fontFamily: "Inter_500Medium" },
  countText: {
    fontSize: 11, color: "#555", fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  card: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: CARD, borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: "rgba(177,152,112,0.12)",
  },
  typeIcon: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  cardBody: { flex: 1, gap: 4 },
  fileName: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "white" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  statusText: { fontSize: 12, fontFamily: "Inter_500Medium" },
  dotSep: { color: "#444", fontSize: 12 },
  dateText: { fontSize: 12, color: "#666", fontFamily: "Inter_400Regular" },
  errorText: { fontSize: 11, color: "#ef444488", fontFamily: "Inter_400Regular", marginTop: 2 },
  deleteBtn: { padding: 8 },
  emptyWrap: { alignItems: "center", paddingVertical: 60, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 20, fontFamily: "Inter_600SemiBold", color: "#555", marginTop: 16, marginBottom: 8 },
  emptyText: { fontSize: 14, color: "#444", fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, marginBottom: 24 },
  cameraBtn: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: PRIMARY, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 14,
  },
  cameraBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "white" },
  settingsBtn: {
    marginTop: 24, paddingHorizontal: 24, paddingVertical: 12,
    borderWidth: 1, borderColor: PRIMARY, borderRadius: 14,
  },
  settingsBtnText: { color: PRIMARY, fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
