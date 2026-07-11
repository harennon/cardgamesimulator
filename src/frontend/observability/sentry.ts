import type { App } from "vue";
import type { Router } from "vue-router";

let _initialised = false;

/** No-op unless VITE_SENTRY_DSN is set. Installs Vue + browser error capture. */
export function initObservability(app: App, router: Router): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  // Dynamic import so the Sentry bundle is excluded entirely when DSN is unset.
  import("@sentry/vue")
    .then((Sentry) => {
      try {
        Sentry.init({
          app,
          dsn,
          // Router integration for breadcrumbs on navigation (no tracing)
          integrations: [],
          // Tracing off — trace_id does not survive WebSocket frames
          tracesSampleRate: 0,
          // Replay off (paid feature)
          replaysSessionSampleRate: 0,
          replaysOnErrorSampleRate: 0,
          sendDefaultPii: false,
          // Supply router so Sentry captures navigation breadcrumbs
          ...(router ? { Vue: app } : {}),
        });
        _initialised = true;
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
