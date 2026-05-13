import React, { useState } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList,
  Alert, ActivityIndicator, RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListUploads, useDeleteUpload, getListUploadsQueryKey,
} from "@workspace/api-client-react";

const PRIMARY = "#b19870";
const BG = "#0d0b08";
const CARD = "#1a1710";

type UploadStatus = "pending" | "uploading" | "done" | "failed" | "queued" | "partial";

const STATUS_CONFIG: Record<UploadStatus, { color: string; icon: string; label: string }> = {
  done: { color: "#22c55e", icon: "cloud-done-outline", label: "Uploaded" },
  uploading: { color: PRIMARY, icon: "cloud-upload-outline", label: "Uploading…" },
  partial: { color: "#f59e0b", icon: "cloud-outline", label: "Partial" },
  failed: { color: "#ef4444", icon: "cloud-offline-outline", label: "Failed" },
  queued: { color: "#6b7280", icon: "time-outline", label: "Queued" },
  pending: { color: "#6b7280", icon: "ellipsis-horizontal-outline", label: "Pending" },
};

function formatDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
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
  const { data: uploads, isLoading, refetch, isRefetching } = useListUploads();
  const deleteMutation = useDeleteUpload();
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const sorted = [...(uploads ?? [])].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const handleDelete = (id: number, fileName: string) => {
    Alert.alert(
      "Remove Record",
      `Remove "${fileName}" from history?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove", style: "destructive",
          onPress: async () => {
            setDeletingId(id);
            try {
              await deleteMutation.mutateAsync({ id });
              queryClient.invalidateQueries({ queryKey: getListUploadsQueryKey() });
            } catch {
              Alert.alert("Error", "Could not remove record.");
            } finally {
              setDeletingId(null);
            }
          },
        },
      ]
    );
  };

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
            <Text style={styles.dot}>·</Text>
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
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={24} color={PRIMARY} />
        <Text style={styles.backBtnText}>Back</Text>
      </TouchableOpacity>

      <Text style={styles.heading}>Upload History</Text>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={PRIMARY} />
        </View>
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={item => String(item.id)}
          contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={PRIMARY}
            />
          }
          ListEmptyComponent={(
            <View style={styles.emptyWrap}>
              <Ionicons name="cloud-upload-outline" size={52} color="#333" />
              <Text style={styles.emptyTitle}>No uploads yet</Text>
              <Text style={styles.emptyText}>
                Photos, videos, and scans you upload will appear here with their status.
              </Text>
              <TouchableOpacity style={styles.cameraBtn} onPress={() => router.replace("/camera")}>
                <Ionicons name="camera-outline" size={18} color="white" />
                <Text style={styles.cameraBtnText}>Open Camera</Text>
              </TouchableOpacity>
            </View>
          )}
          ListHeaderComponent={sorted.length > 0 ? (
            <Text style={styles.countText}>{sorted.length} upload{sorted.length !== 1 ? "s" : ""}</Text>
          ) : null}
          renderItem={renderItem}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  backBtn: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  backBtnText: { fontSize: 15, color: PRIMARY, fontFamily: "Inter_500Medium" },
  heading: { fontSize: 28, fontFamily: "Inter_700Bold", color: "white", paddingHorizontal: 16, paddingBottom: 4 },
  countText: { fontSize: 11, color: "#555", fontFamily: "Inter_600SemiBold", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
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
  dot: { color: "#444", fontSize: 12 },
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
});
