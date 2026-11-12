/**
 * Single place crash/error reports go. Logs locally and, when a Sentry DSN is
 * configured (EXPO_PUBLIC_SENTRY_DSN), forwards to Sentry — so every caller
 * (the root ErrorBoundary and any manual reports) picks it up.
 *
 * Privacy: no PII is sent. sendDefaultPii is off, the only user field ever set
 * is the numeric account id, request bodies / breadcrumb URLs carrying
 * query strings are scrubbed in beforeSend / beforeBreadcrumb, breadcrumb
 * messages have emails / tokens / URL queries redacted, and console
 * breadcrumbs (which can echo anything that was logged) are dropped.
 */
import * as Sentry from "@sentry/react-native";

export interface ErrorReportInfo {
  /** React component stack, when the error came from an error boundary. */
  componentStack?: string | null;
  /** Free-form context (screen, action, ...). Never put credentials or PII here. */
  extra?: Record<string, unknown>;
}

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
let enabled = false;

function stripQuery(url: unknown): unknown {
  return typeof url === "string" ? url.split("?")[0] : url;
}

/**
 * Redact what may identify a person or grant access: email addresses, bearer /
 * JWT-shaped tokens, long opaque secrets, and URL query strings / fragments.
 */
export function scrubText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[jwt]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"']*)[?#][^\s"']*/gi, "$1?[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[secret]");
}

/** Call once, as early as possible (root layout module scope). No-op without a DSN. */
export function initErrorReporting(): void {
  if (enabled || !DSN) return;
  try {
    Sentry.init({
      dsn: DSN,
      sendDefaultPii: false,
      enabled: !__DEV__,
      environment: __DEV__ ? "development" : "production",
      tracesSampleRate: 0,
      beforeSend(event) {
        if (event.request) {
          delete event.request.data;
          delete event.request.cookies;
          delete event.request.headers;
          event.request.url = stripQuery(event.request.url) as string | undefined;
        }
        if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
        return event;
      },
      beforeBreadcrumb(crumb) {
        // console.* breadcrumbs can carry anything that was logged — drop them.
        if (crumb.category === "console") return null;
        if (crumb.data?.url) crumb.data.url = stripQuery(crumb.data.url);
        if (typeof crumb.message === "string") crumb.message = scrubText(crumb.message);
        return crumb;
      },
    });
    enabled = true;
  } catch {
    // Reporting must never break startup.
  }
}

/** Tag reports with the signed-in account id (or clear it on sign-out). */
export function setReportingUser(userId: number | string | null | undefined): void {
  if (!enabled) return;
  try {
    Sentry.setUser(userId != null ? { id: String(userId) } : null);
  } catch {
    // ignore
  }
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
    if (enabled) {
      Sentry.captureException(err, {
        extra: info.extra,
        contexts: info.componentStack ? { react: { componentStack: info.componentStack } } : undefined,
      });
    }
  } catch {
    // Reporting must never throw.
  }
}
