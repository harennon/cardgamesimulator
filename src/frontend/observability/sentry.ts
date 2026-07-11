import type { App } from "vue";
import type { Router } from "vue-router";

let _initialised = false;

/** No-op unless VITE_SENTRY_DSN is set. Installs Vue + browser error capture. */
export function initObservability(
  app: App,
  // router kept for forward-compatibility with LLD interface; not wired to
  // browserTracingIntegration (disabled per LLD — trace_id does not survive WebSockets).
  _router: Router,
  correlationId?: string,
): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  // Dynamic import so the Sentry bundle is excluded entirely when DSN is unset.
  import("@sentry/vue")
    .then((Sentry) => {
      try {
        Sentry.init({
          app,
          dsn,
          integrations: [
            // Vue integration: installs app.config.errorHandler, window.onerror,
            // and unhandledrejection capture.
            Sentry.vueIntegration({ app }),
          ],
          // Tracing off — trace_id does not survive WebSocket frames
          tracesSampleRate: 0,
          // Replay off (paid feature)
          replaysSessionSampleRate: 0,
          replaysOnErrorSampleRate: 0,
          sendDefaultPii: false,
        });
        _initialised = true;
        // Stamp the session-stable correlation id on all subsequent events.
        if (correlationId) {
          Sentry.setTag("correlation_id", correlationId);
        }
      } catch (e) {
        console.warn(
          "[observability] Sentry.init failed, continuing without error capture:",
          e,
        );
      }
    })
    .catch((e) => {
      console.warn("[observability] Failed to load Sentry SDK:", e);
    });
}

export function isInitialised(): boolean {
  return _initialised;
}

/**
 * Guarded breadcrumb helper — safe to call whether or not Sentry is initialised.
 */
export function recordBreadcrumb(b: {
  category: string;
  message: string;
  level?: "info" | "warning" | "error";
  data?: Record<string, unknown>;
}): void {
  if (!_initialised) return;
  // Use dynamic import cache — by this point the module is loaded
  import("@sentry/vue")
    .then((Sentry) => {
      Sentry.addBreadcrumb({
        category: b.category,
        message: b.message,
        level: b.level ?? "info",
        data: b.data,
      });
    })
    .catch(() => {
      // silent — breadcrumb loss is acceptable
    });
}

/** Guarded setTag — safe to call before Sentry is initialised. */
export function setSentryTag(key: string, value: string): void {
  if (!_initialised) return;
  import("@sentry/vue")
    .then((Sentry) => Sentry.setTag(key, value))
    .catch(() => {});
}

/** Guarded setContext — safe to call before Sentry is initialised. */
export function setSentryContext(
  name: string,
  ctx: Record<string, unknown>,
): void {
  if (!_initialised) return;
  import("@sentry/vue")
    .then((Sentry) => Sentry.setContext(name, ctx))
    .catch(() => {});
}
