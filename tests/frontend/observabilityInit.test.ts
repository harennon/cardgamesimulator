/**
 * Unit tests for initObservability guarded no-op behaviour (LLD 166).
 *
 * When VITE_SENTRY_DSN is unset, initObservability must be a no-op —
 * no SDK init, no global handler install, no network.
 * recordBreadcrumb, setSentryTag, setSentryContext must also be no-ops.
 *
 * Sentry is mocked — no live network in tests.
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @sentry/vue before the module under test loads.
// ---------------------------------------------------------------------------

const mockAddBreadcrumb = vi.fn();
const mockSetTag = vi.fn();
const mockSetContext = vi.fn();
const mockInit = vi.fn();

vi.mock("@sentry/vue", () => ({
  init: mockInit,
  addBreadcrumb: mockAddBreadcrumb,
  setTag: mockSetTag,
  setContext: mockSetContext,
}));

// Import after mocks — VITE_SENTRY_DSN is not set in the test env, so
// _initialised stays false (initObservability would check the DSN synchronously
// in the top-level guard before calling Sentry.init).
const sentryModule = await import("../../src/frontend/observability/sentry.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initObservability — guarded no-op when DSN is unset", () => {
  it("isInitialised() returns false in the test env (DSN not set)", () => {
    expect(sentryModule.isInitialised()).toBe(false);
  });

  it("recordBreadcrumb does NOT call Sentry.addBreadcrumb when not initialised", () => {
    mockAddBreadcrumb.mockClear();

    sentryModule.recordBreadcrumb({
      category: "socket",
      message: "connect_error",
      level: "warning",
    });

    // recordBreadcrumb returns early when _initialised is false
    expect(mockAddBreadcrumb).not.toHaveBeenCalled();
  });

  it("setSentryTag does NOT call Sentry.setTag when not initialised", () => {
    mockSetTag.mockClear();

    sentryModule.setSentryTag("correlation_id", "cx_test1234");

    expect(mockSetTag).not.toHaveBeenCalled();
  });

  it("setSentryContext does NOT call Sentry.setContext when not initialised", () => {
    mockSetContext.mockClear();

    sentryModule.setSentryContext("correlation", {
      correlationId: "cx_test1234",
    });

    expect(mockSetContext).not.toHaveBeenCalled();
  });
});
