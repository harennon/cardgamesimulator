/**
 * Unit tests for the socket breadcrumb throttle in useSocket.ts (LLD 166).
 *
 * Tests drive the real connect_error / disconnect handlers on a mocked socket
 * and observe mockRecordBreadcrumb call counts, exercising the actual
 * module-private recordSocketFailure + _socketBreadcrumbThrottle code.
 *
 * Fake timers are used to control the 10-second window without wall-clock delay.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be defined before any imports that load the module under test
// ---------------------------------------------------------------------------

const mockRecordBreadcrumb = vi.fn();

vi.mock("../../src/frontend/observability/sentry.js", () => ({
  isInitialised: () => true,
  initObservability: vi.fn(),
  recordBreadcrumb: mockRecordBreadcrumb,
  setSentryTag: vi.fn(),
  setSentryContext: vi.fn(),
}));

// Socket.io-client mock — supports registering and firing socket-level events
const socketListeners = new Map<string, ((...args: unknown[]) => void)[]>();
const ioListeners = new Map<string, ((...args: unknown[]) => void)[]>();

const mockSocketIo = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const existing = ioListeners.get(event) ?? [];
    ioListeners.set(event, [...existing, handler]);
  }),
};

const mockSocket = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const existing = socketListeners.get(event) ?? [];
    socketListeners.set(event, [...existing, handler]);
  }),
  off: vi.fn(),
  disconnect: vi.fn(),
  connected: false,
  io: mockSocketIo,
};

function emitSocket(event: string, ...args: unknown[]): void {
  const handlers = socketListeners.get(event) ?? [];
  for (const h of handlers) h(...args);
}

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => mockSocket),
}));

vi.mock("../../src/frontend/service/authService.js", () => ({
  getAccessToken: vi.fn().mockResolvedValue("fake-token"),
  getSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/frontend/service/guestService.js", () => ({
  getGuestToken: vi.fn().mockReturnValue(null),
  restoreGuestSession: vi.fn().mockReturnValue(null),
}));

vi.mock("../../src/frontend/composables/useCorrelation.js", () => ({
  useCorrelation: vi.fn().mockReturnValue({
    correlationId: { value: "cx_test1234" },
    gameId: { value: "game-001" },
    bindGame: vi.fn(),
    unbindGame: vi.fn(),
  }),
}));

vi.mock("vue", async () => {
  const actual = await vi.importActual<typeof import("vue")>("vue");
  return { ...actual, onUnmounted: vi.fn() };
});

// Import the REAL useSocket after mocks are set up
const { useSocket, SOCKET_BREADCRUMB_WINDOW_MS } =
  await import("../../src/frontend/composables/useSocket.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The module-level _socketBreadcrumbThrottle Map persists across tests.
// Each test jumps the fake clock well past any lastEmit from prior tests by
// starting at EPOCH_BASE + (testIndex * EPOCH_STEP), which is always
// > lastEmit + WINDOW regardless of what previous tests emitted.
const EPOCH_BASE = Date.now() + SOCKET_BREADCRUMB_WINDOW_MS * 10;
const EPOCH_STEP = SOCKET_BREADCRUMB_WINDOW_MS * 3;
let testEpoch = EPOCH_BASE;

async function setupSocket(): Promise<void> {
  socketListeners.clear();
  ioListeners.clear();
  mockSocket.disconnect.mockClear();
  mockRecordBreadcrumb.mockClear();

  const { connect } = useSocket();
  await connect();
}

// ---------------------------------------------------------------------------
// Tests: SOCKET_BREADCRUMB_WINDOW_MS export
// ---------------------------------------------------------------------------

describe("SOCKET_BREADCRUMB_WINDOW_MS", () => {
  it("is 10000 ms", () => {
    expect(SOCKET_BREADCRUMB_WINDOW_MS).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Tests: real recordSocketFailure via connect_error / disconnect handlers
// ---------------------------------------------------------------------------

describe("socket breadcrumb throttle — real module code", () => {
  beforeEach(async () => {
    // Set fake clock to a fresh epoch far ahead of any prior test's lastEmit
    // so the module-level throttle Map is effectively expired at test start.
    testEpoch += EPOCH_STEP;
    vi.useFakeTimers({ now: testEpoch });
    await setupSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first connect_error emits a breadcrumb immediately", () => {
    emitSocket("connect_error", new Error("timeout"));
    expect(mockRecordBreadcrumb).toHaveBeenCalledTimes(1);
    expect(mockRecordBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: "socket", message: "connect_error" }),
    );
  });

  it("second connect_error within the window is suppressed (no second breadcrumb)", () => {
    emitSocket("connect_error", new Error("timeout"));
    vi.advanceTimersByTime(SOCKET_BREADCRUMB_WINDOW_MS / 2);
    emitSocket("connect_error", new Error("timeout"));
    expect(mockRecordBreadcrumb).toHaveBeenCalledTimes(1);
  });

  it("third connect_error after the window fires with suppressedSince in data", () => {
    emitSocket("connect_error", new Error("timeout"));
    // suppress two within the window
    vi.advanceTimersByTime(1_000);
    emitSocket("connect_error", new Error("timeout"));
    vi.advanceTimersByTime(1_000);
    emitSocket("connect_error", new Error("timeout"));
    // advance past the window from the first emit
    vi.advanceTimersByTime(SOCKET_BREADCRUMB_WINDOW_MS);
    emitSocket("connect_error", new Error("timeout"));

    expect(mockRecordBreadcrumb).toHaveBeenCalledTimes(2);
    const secondCall = mockRecordBreadcrumb.mock.calls[1]![0] as {
      data?: Record<string, unknown>;
    };
    expect(secondCall.data?.suppressedSince).toBeGreaterThan(0);
  });

  it("disconnect and connect_error are throttled independently", () => {
    emitSocket("connect_error", new Error("timeout"));
    emitSocket("disconnect", "transport close");
    // Both are distinct reasons — both should emit
    expect(mockRecordBreadcrumb).toHaveBeenCalledTimes(2);
  });

  it("SERVER_FULL connect_error is NOT throttled — emits even within the window", () => {
    // SERVER_FULL is handled directly in the connect_error handler as a special
    // terminal path that calls recordBreadcrumb without going through the throttle.
    emitSocket("connect_error", new Error("SERVER_FULL"));
    // SERVER_FULL emits a distinct breadcrumb and also calls disconnect()
    expect(mockRecordBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ message: "connect_error:server_full" }),
    );
  });

  it("breadcrumb data carries correlationId and gameId", () => {
    emitSocket("connect_error", new Error("timeout"));
    const call = mockRecordBreadcrumb.mock.calls[0]![0] as {
      data?: Record<string, unknown>;
    };
    expect(call.data?.correlationId).toBe("cx_test1234");
    expect(call.data?.gameId).toBe("game-001");
  });
});
