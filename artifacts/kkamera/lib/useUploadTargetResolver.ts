import { useCallback, useEffect, useRef } from "react";
import { useGetUploadTarget } from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { resolveUploadTarget, type ResolvedTarget, type UploadTargetValue } from "@/lib/uploadTarget";
import { readCachedUploadTarget, writeCachedUploadTarget } from "@/lib/offlineCache";

/** How long a capture waits for the target endpoint when nothing is cached. */
const FETCH_TIMEOUT_MS = 8000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(undefined); });
  });
}

/**
 * Resolve the user's upload destination for a capture without ever widening it.
 *
 * Order: the live query → the last target seen for this user (AsyncStorage) →
 * a bounded refetch → "all". The final "all" is only reached when this device
 * has never seen a target for the user, i.e. they have not chosen one here
 * (the server default is "all"). A cached "none"/"selected" is always honoured
 * offline, so a capture never fans out to accounts the user excluded.
 */
export function useUploadTargetResolver() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const query = useGetUploadTarget();
  const { data, refetch } = query;
  const cached = useRef<{ userId: number | null; value: UploadTargetValue | null } | null>(null);

  // Keep the per-user cache in step with every value the server hands us.
  useEffect(() => {
    if (!data || userId == null) return;
    const value: UploadTargetValue = { mode: data.mode, connectionIds: data.connectionIds ?? [] };
    cached.current = { userId, value };
    void writeCachedUploadTarget(userId, value);
  }, [data, userId]);

  const getUploadTarget = useCallback(async (): Promise<ResolvedTarget> => {
    if (data) return resolveUploadTarget(data);

    let fallback: UploadTargetValue | null =
      cached.current && cached.current.userId === userId ? cached.current.value : null;
    if (!fallback) fallback = await readCachedUploadTarget(userId);
    if (fallback) return resolveUploadTarget(fallback);

    const fetched = await withTimeout(refetch().then(r => r.data), FETCH_TIMEOUT_MS);
    if (fetched) {
      void writeCachedUploadTarget(userId, { mode: fetched.mode, connectionIds: fetched.connectionIds ?? [] });
      return resolveUploadTarget(fetched);
    }
    return resolveUploadTarget(undefined);
  }, [data, refetch, userId]);

  return { uploadTarget: data, getUploadTarget };
}
