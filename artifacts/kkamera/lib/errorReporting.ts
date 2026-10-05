/**
 * Single place crash/error reports go. Today it only logs; plug a crash
 * reporter (e.g. Sentry.captureException) in here later so every caller —
 * the root ErrorBoundary and any manual reports — picks it up.
 */

export interface ErrorReportInfo {
  /** React component stack, when the error came from an error boundary. */
  componentStack?: string | null;
  /** Free-form context (screen, action, ...). Never put credentials or PII here. */
  extra?: Record<string, unknown>;
}

export function reportError(error: unknown, info: ErrorReportInfo = {}): void {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(
      "[KKamera] Unhandled error:",
      err,
      info.componentStack ? `\nComponent stack:${info.componentStack}` : "",
      info.extra ?? "",
    );
    // TODO: forward to a crash reporter (Sentry) here.
  } catch {
    // Reporting must never throw.
  }
}
