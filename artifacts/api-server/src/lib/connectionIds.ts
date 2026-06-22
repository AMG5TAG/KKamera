/**
 * Parse a client-supplied connectionIds value (a JSON array or a CSV string)
 * into a canonical CSV of positive integer ids, or null when none are valid.
 * Pure & dependency-free (unit-tested). Note: this only normalises the *format*;
 * ownership/active checks happen at upload time against the DB.
 */
export function normalizeConnectionIds(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let parts: unknown[];
  try {
    const j = JSON.parse(raw);
    parts = Array.isArray(j) ? j : [j];
  } catch {
    parts = raw.split(",");
  }
  const ids = parts
    .map((p) => parseInt(String(p).trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? ids.join(",") : null;
}
