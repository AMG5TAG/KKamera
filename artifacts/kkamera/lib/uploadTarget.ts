// Shared resolution of the user's upload-destination default, used by every
// capture path (camera, time-lapse, markup) so they behave identically.

export interface UploadTargetValue {
  mode?: string;
  connectionIds?: number[];
}

export interface ResolvedTarget {
  /** True when the capture should NOT be uploaded (kept locally only). */
  skip: boolean;
  /** Connection ids to upload to; undefined = all active connections. */
  ids: number[] | undefined;
}

/**
 * Resolve a target value into an upload decision.
 *  - "none"                  → skip upload
 *  - "selected" with ids     → upload to exactly those ids
 *  - "selected" with NO ids  → skip (upload nowhere) — must NEVER fall through to
 *                              "all", which would send captures to every account
 *                              the user deliberately excluded
 *  - "all" / unknown         → undefined ids (server uploads to all active)
 */
export function resolveUploadTarget(t: UploadTargetValue | undefined): ResolvedTarget {
  const mode = t?.mode ?? "all";
  if (mode === "none") return { skip: true, ids: undefined };
  if (mode === "selected") {
    const ids = t?.connectionIds ?? [];
    if (ids.length === 0) return { skip: true, ids: undefined };
    return { skip: false, ids };
  }
  return { skip: false, ids: undefined };
}
