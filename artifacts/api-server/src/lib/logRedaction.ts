/**
 * Secret redaction for logged errors. Dependency-free so it is unit-tested in
 * isolation (test/logRedaction.test.ts); wired into the pino `err` serializer
 * in lib/logger.ts, which covers every logger call AND pino-http's req.log.
 *
 * An FTP server that echoes a command back in its reply (e.g.
 * "500 'PASS hunter2': command not understood", which a password containing
 * CR/LF used to provoke) puts the password into the error message and stack.
 */

const PASS_COMMAND = /\bPASS\b[^\r\n]*/gi;
const MAX_DEPTH = 6;

/** Redact an echoed FTP `PASS …` command from one string. */
export function redactPassText(v: string): string {
  return /\bPASS\b/i.test(v) ? v.replace(PASS_COMMAND, "PASS [redacted]") : v;
}

/**
 * Redact secrets from an already-serialized error (a plain object from pino's
 * std err serializer): every string value, including nested `cause` /
 * aggregated errors, is scrubbed. Returns the same object when nothing changed.
 */
export function redactSerializedError<T>(value: T, depth = 0, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return redactPassText(value) as T;
  if (!value || typeof value !== "object" || depth >= MAX_DEPTH || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = redactSerializedError(v, depth + 1, seen);
      if (r !== v) changed = true;
      return r;
    });
    return (changed ? out : value) as T;
  }
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const r = redactSerializedError(v, depth + 1, seen);
    if (r !== v) {
      out ??= { ...(value as Record<string, unknown>) };
      out[k] = r;
    }
  }
  return (out ?? value) as T;
}
