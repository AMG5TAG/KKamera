import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList,
  Alert, ActivityIndicator, RefreshControl,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  useDeleteUpload, useClearUploads, getListUploadsQueryKey, getUserFacingMessage,
  type UploadItem,
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useUpload, type QueuedUpload } from "@/contexts/UploadContext";
import { API_BASE_URL } from "@/lib/config";
import { palette } from "@/components/ui/palette";

const PRIMARY = palette.primary;
const BG = palette.bg;
const CARD = palette.card;

/** Rows per page; the server accepts limit 1–200 with an offset. */
const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 45_000;

// Under the generated list key, so every existing invalidation of
// getListUploadsQueryKey() (here and in UploadContext) also refreshes this.
const HISTORY_QUERY_KEY = [...getListUploadsQueryKey(), "infinite", PAGE_SIZE] as const;

/**
 * One page of upload history. The generated `listUploads` has no limit/offset
 * parameters yet (the server supports them), so this calls the endpoint
 * directly with the session token.
 */
async function fetchUploadsPage(
  token: string,
  offset: number,
  signal: AbortSignal | undefined,
  onUnauthorized: (tokenUsed: string) => void,
): Promise<UploadItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(`${API_BASE_URL}/api/uploads?limit=${PAGE_SIZE}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      // Bypasses customFetch, so report 401s to the shared handler ourselves.
      if (res.status === 401) onUnauthorized(token);
      const body = await res.json().catch(() => null) as { message?: string } | null;
      throw new Error(body?.message || `Couldn't load history (${res.status}).`);
    }
    return await res.json() as UploadItem[];
  } catch (e) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error("The request timed out. Check your connection and try again.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

type Filter = "all" | "failed" | "queued" | "done";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "queued", label: "Queued" },
  { id: "done", label: "Done" },
];

function matchesFilter(status: string | null | undefined, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "failed") return status === "failed" || status === "partial";
  if (filter === "queued") return status === "queued" || status === "pending" || status === "uploading" || !status;
  return status === "done";
}

type UploadStatus = "pending" | "uploading" | "done" | "failed" | "queued" | "partial";

const STATUS_CONFIG: Record<UploadStatus, { color: string; icon: string; label: string }> = {
  done:      { color: "#22c55e", icon: "cloud-done-outline",       label: "Uploaded"   },
  uploading: { color: PRIMARY,   icon: "cloud-upload-outline",     label: "Uploading…" },
  partial:   { color: "#f59e0b", icon: "cloud-outline",            label: "Partial"    },
  failed:    { color: palette.dangerText, icon: "cloud-offline-outline",    label: "Failed"     },
  queued:    { color: "#9ca3af", icon: "time-outline",             label: "Queued"     },
  pending:   { color: "#9ca3af", icon: "ellipsis-horizontal-outline", label: "Pending" },
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
  const { token, reportUnauthorized } = useAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const historyQuery = useInfiniteQuery({
    queryKey: HISTORY_QUERY_KEY,
    queryFn: ({ pageParam, signal }) => fetchUploadsPage(token!, pageParam, signal, reportUnauthorized),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.length < PAGE_SIZE ? undefined : all.length * PAGE_SIZE),
    enabled: !!token && settings.recordHistory,
  });
  const {
    data, isLoading, isError, error, refetch,
    fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError,
  } = historyQuery;
  // Offset paging can repeat a row when new uploads land between pages.
  const uploads = useMemo(() => {
    const seen = new Set<number>();
    const out: UploadItem[] = [];
    for (const page of data?.pages ?? []) {
      for (const u of page) {
        if (seen.has(u.id)) continue;
        seen.add(u.id);
        out.push(u);
      }
    }
    return out;
  }, [data]);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await refetch(); } finally { setRefreshing(false); }
  }, [refetch]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const deleteMutation = useDeleteUpload();
  const clearMutation = useClearUploads();
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const { queuedItems, retryItem, discardItem } = useUpload();

  const sorted = [...uploads].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // A capture still held on this device (e.g. a partial upload being retried)
  // is shown once, in "On this device" — hide its server row until it leaves
  // the local queue. The server reuses one row per clientUploadId (the queue
  // item id), so after that there is exactly one server row for it.
  const localIds = useMemo(() => new Set(queuedItems.map(i => i.id)), [queuedItems]);
  const unfiltered = sorted.filter(u => !u.clientUploadId || !localIds.has(u.clientUploadId));
  const visible = unfiltered.filter(u => matchesFilter(u.status, filter));
  const visibleQueued = queuedItems.filter(i => matchesFilter(i.status, filter));

  // When a capture leaves the local queue (uploaded, or discarded) refresh the
  // server list so its final row appears without a manual pull-to-refresh.
  const prevLocalIds = useRef(localIds);
  useEffect(() => {
    const left = [...prevLocalIds.current].some(id => !localIds.has(id));
    prevLocalIds.current = localIds;
    if (left) queryClient.invalidateQueries({ queryKey: getListUploadsQueryKey() });
  }, [localIds, queryClient]);

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
      hasNextPage
        ? "This will permanently delete all of your upload records. This cannot be undone."
        : `This will permanently delete all ${sorted.length} upload records. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear All", style: "destructive",
          onPress: async () => {
            setIsClearing(true);
            try {
              await clearMutation.mutateAsync();
              // Scrub the cached list immediately, then revalidate against the server
              queryClient.setQueryData<InfiniteData<UploadItem[], number>>(
                HISTORY_QUERY_KEY, { pages: [[]], pageParams: [0] },
              );
              queryClient.invalidateQueries({ queryKey: getListUploadsQueryKey() });
            } catch { Alert.alert("Error", "Could not clear history."); }
            finally { setIsClearing(false); }
          },
        },
      ]
    );
  }, [sorted.length, hasNextPage, queryClient, clearMutation]);

  const handleDiscard = (item: QueuedUpload) => {
    Alert.alert(
      "Discard Capture",
      `"${item.fileName}" hasn't been uploaded. Discarding deletes the only copy on this device. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: () => { void discardItem(item.id); } },
      ]
    );
  };

  const renderQueuedItem = (item: QueuedUpload) => {
    const cfg = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.queued;
    const uploading = item.status === "uploading";
    return (
      <View key={item.id} style={styles.card}>
        <View style={[styles.typeIcon, { backgroundColor: cfg.color + "22" }]}>
          <Ionicons name={fileIcon(item.fileType, item.fileName) as any} size={20} color={cfg.color} accessible={false} />
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.fileName} numberOfLines={1}>{item.fileName}</Text>
          <View style={styles.metaRow}>
            <Ionicons name={cfg.icon as any} size={12} color={cfg.color} accessible={false} />
            <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
            <Text style={styles.dotSep}>·</Text>
            <Text style={styles.dateText}>{formatDate(new Date(item.createdAt).toISOString())}</Text>
          </View>
          {!!item.error && (
            <Text
              style={item.status === "failed" || item.status === "partial" ? styles.errorText : styles.queueNote}
              numberOfLines={2}
            >
              {item.error}
            </Text>
          )}
        </View>
        {uploading ? (
          <ActivityIndicator size="small" color={PRIMARY} style={styles.deleteBtn} accessibilityLabel="Uploading" />
        ) : (
          <>
            <TouchableOpacity
              style={styles.deleteBtn}
              onPress={() => retryItem(item.id)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Retry upload of ${item.fileName}`}
            >
              <Ionicons name="refresh-outline" size={18} color={PRIMARY} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.deleteBtn}
              onPress={() => handleDiscard(item)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Discard ${item.fileName}`}
            >
              <Ionicons name="trash-outline" size={18} color={palette.dangerText} />
            </TouchableOpacity>
          </>
        )}
      </View>
    );
  };

  const deviceSection = visibleQueued.length > 0 ? (
    <View style={styles.deviceSection}>
      <Text style={styles.countText}>
        On this device · {visibleQueued.length} not uploaded
      </Text>
      {visibleQueued.map(renderQueuedItem)}
    </View>
  ) : null;

  const filterChips = (
    <View style={styles.chipRow} accessibilityRole="tablist">
      {FILTERS.map(f => {
        const selected = filter === f.id;
        return (
          <TouchableOpacity
            key={f.id}
            style={[styles.chip, selected && styles.chipSelected]}
            onPress={() => setFilter(f.id)}
            hitSlop={{ top: 6, bottom: 6 }}
            accessibilityRole="tab"
            accessibilityLabel={`Show ${f.label.toLowerCase()} uploads`}
            accessibilityState={{ selected }}
          >
            <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{f.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  if (!settings.recordHistory) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={28} color={PRIMARY} />
        </TouchableOpacity>
        {deviceSection && <View style={{ paddingHorizontal: 16 }}>{deviceSection}</View>}
        <View style={styles.center}>
          <Ionicons name="eye-off-outline" size={48} color={palette.textSubtle} accessible={false} />
          <Text style={styles.emptyTitle}>History is hidden</Text>
          <Text style={styles.emptyText}>
            Turn on "Show Upload History" in Settings → Upload to see past uploads on this device.
          </Text>
          <TouchableOpacity style={styles.settingsBtn} onPress={() => router.push("/settings/upload" as any)} accessibilityRole="button">
            <Text style={styles.settingsBtnText}>Open Upload Settings</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const renderItem = ({ item }: { item: UploadItem }) => {
    const status = (item.status ?? "pending") as UploadStatus;
    const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.pending;
    const isDeleting = deletingId === item.id;

    return (
      <View style={[styles.card, isDeleting && { opacity: 0.5 }]}>
        <View style={[styles.typeIcon, { backgroundColor: cfg.color + "22" }]}>
          <Ionicons name={fileIcon(item.fileType, item.fileName) as any} size={20} color={cfg.color} accessible={false} />
        </View>
        <View style={styles.cardBody}>
          <Text style={styles.fileName} numberOfLines={1}>{item.fileName}</Text>
          <View style={styles.metaRow}>
            <Ionicons name={cfg.icon as any} size={12} color={cfg.color} accessible={false} />
            <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>
            <Text style={styles.dotSep}>·</Text>
            <Text style={styles.dateText}>{formatDate(item.createdAt)}</Text>
          </View>
          {item.error && (status === "failed" || status === "partial") && (
            <Text style={styles.errorText} numberOfLines={2}>{item.error}</Text>
          )}
        </View>
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={() => handleDelete(item.id, item.fileName)}
          disabled={isDeleting}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${item.fileName} from history`}
          accessibilityState={{ disabled: isDeleting, busy: isDeleting }}
        >
          {isDeleting
            ? <ActivityIndicator size="small" color={palette.dangerText} />
            : <Ionicons name="trash-outline" size={18} color={palette.dangerText} />
          }
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.headerRow}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={28} color={PRIMARY} />
        </TouchableOpacity>
        <Text style={styles.heading} accessibilityRole="header">Upload History</Text>
        {unfiltered.length > 0 && (
          <TouchableOpacity
            onPress={handleClearAll}
            disabled={isClearing}
            style={styles.clearAllBtn}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            accessibilityRole="button"
            accessibilityLabel="Clear all upload history"
            accessibilityState={{ disabled: isClearing, busy: isClearing }}
          >
            {isClearing
              ? <ActivityIndicator size="small" color="#ef4444" />
              : (
                <>
                  <Ionicons name="trash-outline" size={15} color="#ef4444" accessible={false} />
                  <Text style={styles.clearAllText}>Clear</Text>
                </>
              )
            }
          </TouchableOpacity>
        )}
      </View>

      {filterChips}

      {isLoading ? (
        <>
          {deviceSection && <View style={{ paddingHorizontal: 16 }}>{deviceSection}</View>}
          <View style={styles.center}><ActivityIndicator color={PRIMARY} accessibilityLabel="Loading history" /></View>
        </>
      ) : isError && !data ? (
        <>
          {deviceSection && <View style={{ paddingHorizontal: 16 }}>{deviceSection}</View>}
          <View style={styles.center}>
            <Ionicons name="cloud-offline-outline" size={48} color={palette.textSubtle} accessible={false} />
            <Text style={styles.emptyTitle} accessibilityRole="header">Couldn't load history</Text>
            <Text style={styles.emptyText}>{getUserFacingMessage(error, "Something went wrong. Please try again.")}</Text>
            <TouchableOpacity
              style={styles.cameraBtn}
              onPress={() => { void onRefresh(); }}
              disabled={refreshing}
              accessibilityRole="button"
              accessibilityLabel="Retry loading history"
              accessibilityState={{ disabled: refreshing, busy: refreshing }}
            >
              {refreshing
                ? <ActivityIndicator size="small" color="white" />
                : (
                  <>
                    <Ionicons name="refresh-outline" size={18} color="white" accessible={false} />
                    <Text style={styles.cameraBtnText}>Retry</Text>
                  </>
                )}
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={item => String(item.id)}
          contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PRIMARY} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={(deviceSection || visible.length > 0) ? (
            <>
              {deviceSection}
              {visible.length > 0 && (
                <Text style={styles.countText}>
                  {visible.length}{hasNextPage ? "+" : ""} record{visible.length !== 1 ? "s" : ""}
                  {filter !== "all" ? " (loaded)" : ""}
                </Text>
              )}
            </>
          ) : null}
          ListFooterComponent={
            isFetchingNextPage ? (
              <ActivityIndicator color={PRIMARY} style={{ marginVertical: 16 }} accessibilityLabel="Loading more" />
            ) : isFetchNextPageError ? (
              <TouchableOpacity
                style={styles.loadMoreBtn}
                onPress={() => { void fetchNextPage(); }}
                accessibilityRole="button"
                accessibilityLabel="Couldn't load more. Retry"
              >
                <Ionicons name="refresh-outline" size={16} color={PRIMARY} accessible={false} />
                <Text style={styles.loadMoreText}>Couldn't load more — Retry</Text>
              </TouchableOpacity>
            ) : hasNextPage && filter !== "all" && visible.length === 0 ? (
              // Client-side filter over loaded pages: let the user reach older rows.
              <TouchableOpacity style={styles.loadMoreBtn} onPress={loadMore} accessibilityRole="button">
                <Text style={styles.loadMoreText}>Load older uploads</Text>
              </TouchableOpacity>
            ) : null
          }
          ListEmptyComponent={deviceSection ? null : filter !== "all" ? (
            <View style={styles.emptyWrap}>
              <Ionicons name="filter-outline" size={44} color={palette.textSubtle} accessible={false} />
              <Text style={styles.emptyTitle}>No {FILTERS.find(f => f.id === filter)?.label.toLowerCase()} uploads</Text>
              <TouchableOpacity style={styles.settingsBtn} onPress={() => setFilter("all")} accessibilityRole="button">
                <Text style={styles.settingsBtnText}>Show all</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.emptyWrap}>
              <Ionicons name="cloud-upload-outline" size={52} color={palette.textSubtle} accessible={false} />
              <Text style={styles.emptyTitle}>No uploads yet</Text>
              <Text style={styles.emptyText}>Photos, videos, and scans you upload will appear here.</Text>
              <TouchableOpacity style={styles.cameraBtn} onPress={() => router.replace("/camera" as any)} accessibilityRole="button">
                <Ionicons name="camera-outline" size={18} color="white" accessible={false} />
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
  backBtn: { padding: 12, minWidth: 44, minHeight: 44 },
  chipRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 },
  chip: {
    minHeight: 34, paddingHorizontal: 14, borderRadius: 17, justifyContent: "center",
    borderWidth: 1, borderColor: "rgba(177,152,112,0.25)", backgroundColor: CARD,
  },
  chipSelected: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  chipText: { fontSize: 13, color: palette.textMuted, fontFamily: "Inter_500Medium" },
  chipTextSelected: { color: "#0d0b08", fontFamily: "Inter_600SemiBold" },
  loadMoreBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    minHeight: 44, marginTop: 8, borderRadius: 12, borderWidth: 1, borderColor: "rgba(177,152,112,0.3)",
  },
  loadMoreText: { fontSize: 14, color: PRIMARY, fontFamily: "Inter_500Medium" },
  heading: { flex: 1, fontSize: 22, fontFamily: "Inter_700Bold", color: "white", paddingLeft: 4 },
  clearAllBtn: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 10, paddingVertical: 6, minHeight: 36,
    borderRadius: 10, borderWidth: 1, borderColor: "rgba(239,68,68,0.35)",
  },
  clearAllText: { fontSize: 13, color: palette.dangerText, fontFamily: "Inter_500Medium" },
  countText: {
    fontSize: 11, color: palette.textSubtle, fontFamily: "Inter_600SemiBold",
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
  dateText: { fontSize: 12, color: palette.textSubtle, fontFamily: "Inter_400Regular" },
  // AA: ~6:1 on CARD at 12pt (was #ef444488 at 11pt, ~2.6:1).
  errorText: { fontSize: 12, color: palette.dangerText, fontFamily: "Inter_400Regular", marginTop: 2, lineHeight: 16 },
  deleteBtn: { padding: 8, minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  deviceSection: { gap: 10, marginBottom: 20 },
  queueNote: { fontSize: 12, color: palette.textMuted, fontFamily: "Inter_400Regular", marginTop: 2 },
  emptyWrap: { alignItems: "center", paddingVertical: 60, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 20, fontFamily: "Inter_600SemiBold", color: palette.textMuted, marginTop: 16, marginBottom: 8, textAlign: "center" },
  emptyText: { fontSize: 14, color: palette.textSubtle, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20, marginBottom: 24 },
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
