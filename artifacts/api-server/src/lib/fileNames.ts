/**
 * Strip any path components from a client-supplied filename so it cannot
 * traverse out of the configured upload directory (e.g. "../../etc/x").
 * Returns just the final path segment with leading dots/whitespace removed,
 * falling back to a generated name when nothing usable remains.
 * Pure & dependency-free (unit-tested).
 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/^\.+/, "").trim();
  return cleaned || `upload_${Date.now()}`;
}
