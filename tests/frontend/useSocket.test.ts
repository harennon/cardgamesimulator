import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("socket.io-client", () => {
  // Socket-level listeners (connect, disconnect, connect_error)
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  // Manager-level listeners (reconnect_attempt, reconnect, reconnect_failed)
  const ioListeners = new Map<string, ((...args: unknown[]) => void)[]>();

  const mockIo = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const existing = ioListeners.get(event) ?? [];
      ioListeners.set(event, [...existing, handler]);
    }),
  };

  const mockSocket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? [];
      listeners.set(event, [...existing, handler]);
    }),
    off: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
    // The Socket.IO Manager is exposed on socket.io
    io: mockIo,
  };

  function emit(event: string, ...args: unknown[]): void {
    const handlers = listeners.get(event) ?? [];
    for (const h of handlers) {
      h(...args);
    }
  }

  function emitIo(event: string, ...args: unknown[]): void {
    const handlers = ioListeners.get(event) ?? [];
    for (const h of handlers) {
      h(...args);
    }
  }

  return {
    io: vi.fn(() => mockSocket),
    __mockSocket: mockSocket,
    __emit: emit,
    __emitIo: emitIo,
    __resetListeners: () => {
      listeners.clear();
      ioListeners.clear();
    },
  };
});

vi.mock("@/service/authService", () => ({
  getAccessToken: vi.fn().mockResolvedValue("fake-token"),
  getSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/service/guestService", () => ({
  getGuestToken: vi.fn().mockReturnValue(null),
  restoreGuestSession: vi.fn().mockReturnValue(null),
}));

vi.mock("vue", async () => {
  const actual = await vi.importActual<typeof import("vue")>("vue");
  return {
    ...actual,
    onUnmounted: vi.fn(),
  };
});

describe("useSocket — SERVER_FULL handling (LLD 162)", () => {
  beforeEach(async () => {
    const { __resetListeners } = await import("socket.io-client");
    (__resetListeners as unknown as () => void)();
    const { __mockSocket } = await import("socket.io-client");
    (
      __mockSocket as unknown as { disconnect: ReturnType<typeof vi.fn> }
    ).disconnect.mockClear();
  });

  it("sets terminalError and disconnects on SERVER_FULL", async () => {
    const { useSocket } =
      await import("../../src/frontend/composables/useSocket.js");
    const { __emit, __mockSocket } = await import("socket.io-client");

    const { socket, terminalError, connected, connect } = useSocket();
    await connect();

    expect(socket.value).not.toBeNull();

    (__emit as unknown as (event: string, ...args: unknown[]) => void)(
      "connect_error",
      new Error("SERVER_FULL"),
    );

    expect(terminalError.value).toBe(
      "Server is at capacity. Please try again shortly.",
    );
    expect(connected.value).toBe(false);
    expect(
      (__mockSocket as unknown as { disconnect: ReturnType<typeof vi.fn> })
        .disconnect,
    ).toHaveBeenCalled();
  });

  it("does NOT disconnect and does NOT set terminalError on other connect errors", async () => {
    const { useSocket } =
      await import("../../src/frontend/composables/useSocket.js");
    const { __emit, __mockSocket } = await import("socket.io-client");

    const { terminalError, connect } = useSocket();
    await connect();

    (__emit as unknown as (event: string, ...args: unknown[]) => void)(
      "connect_error",
      new Error("timeout"),
    );

    // Transient connect_error must NOT set terminalError (LLD 162 core fix).
    expect(terminalError.value).toBeNull();
    expect(
      (__mockSocket as unknown as { disconnect: ReturnType<typeof vi.fn> })
        .disconnect,
    ).not.toHaveBeenCalled();
  });

  it("connectionState transitions to 'reconnecting' on disconnect(transport close) after grace window", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket, RECONNECTING_GRACE_MS } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit } = await import("socket.io-client");

      const { connectionState, connect } = useSocket();
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "transport close",
      );

      // Before grace window elapses, state should still be "connected".
      expect(connectionState.value).toBe("connected");

      // After grace window elapses, state should be "reconnecting".
      vi.advanceTimersByTime(RECONNECTING_GRACE_MS);
      expect(connectionState.value).toBe("reconnecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("connectionState transitions to 'connected' on reconnect", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket, RECONNECTING_GRACE_MS } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit } = await import("socket.io-client");

      const { connectionState, reconnectAttempt, connect } = useSocket();
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "transport close",
      );

      // Advance past grace window to enter reconnecting first.
      vi.advanceTimersByTime(RECONNECTING_GRACE_MS);
      expect(connectionState.value).toBe("reconnecting");

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );

      expect(connectionState.value).toBe("connected");
      expect(reconnectAttempt.value).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("connectionState transitions to 'terminal' on reconnect_failed", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit, __emitIo } = await import("socket.io-client");

      const { connectionState, connect } = useSocket();
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "transport close",
      );
      (__emitIo as unknown as (event: string, ...args: unknown[]) => void)(
        "reconnect_failed",
      );

      expect(connectionState.value).toBe("terminal");
    } finally {
      vi.useRealTimers();
    }
  });

  it("connectionState → 'terminal' on 'io server disconnect' (non-retrying)", async () => {
    const { useSocket } =
      await import("../../src/frontend/composables/useSocket.js");
    const { __emit } = await import("socket.io-client");

    const { connectionState, connect } = useSocket();
    await connect();

    (__emit as unknown as (event: string, ...args: unknown[]) => void)(
      "connect",
    );
    (__emit as unknown as (event: string, ...args: unknown[]) => void)(
      "disconnect",
      "io server disconnect",
    );

    expect(connectionState.value).toBe("terminal");
  });

  it("reconnectAttempt counter updates from Manager events", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit, __emitIo } = await import("socket.io-client");

      const { reconnectAttempt, connect } = useSocket();
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "transport close",
      );
      (__emitIo as unknown as (event: string, ...args: unknown[]) => void)(
        "reconnect_attempt",
        3,
      );

      // reconnectAttempt is updated synchronously, regardless of grace window
      expect(reconnectAttempt.value).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useSocket — grace-window debounce (LLD 165)", () => {
  beforeEach(async () => {
    const { __resetListeners } = await import("socket.io-client");
    (__resetListeners as unknown as () => void)();
  });

  it("no banner for a sub-window blip (primary AC): connectionState never 'reconnecting'", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket, RECONNECTING_GRACE_MS } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit } = await import("socket.io-client");

      const { connectionState, connect } = useSocket();
      await connect();

      // Collect all state values observed
      const observed: string[] = [connectionState.value];
      // We'll sample after key events

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      observed.push(connectionState.value);

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "transport close",
      );
      observed.push(connectionState.value);

      // Advance by less than grace window
      vi.advanceTimersByTime(RECONNECTING_GRACE_MS - 100);
      observed.push(connectionState.value);

      // Reconnect fires before grace window expires
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      observed.push(connectionState.value);

      // Advance past what would have been the grace window — timer was cancelled
      vi.advanceTimersByTime(500);
      observed.push(connectionState.value);

      // "reconnecting" must never have appeared
      expect(observed).not.toContain("reconnecting");
      expect(connectionState.value).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("genuine drop surfaces 'reconnecting' after the grace window", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket, RECONNECTING_GRACE_MS } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit } = await import("socket.io-client");

      const { connectionState, connect } = useSocket();
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "transport close",
      );

      // Before the grace window, state should still be "connected"
      expect(connectionState.value).toBe("connected");

      vi.advanceTimersByTime(RECONNECTING_GRACE_MS);

      expect(connectionState.value).toBe("reconnecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovery is immediate once reconnecting is showing (not debounced)", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket, RECONNECTING_GRACE_MS } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit } = await import("socket.io-client");

      const { connectionState, connect } = useSocket();
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "transport close",
      );

      // Let the grace window expire so banner is showing
      vi.advanceTimersByTime(RECONNECTING_GRACE_MS);
      expect(connectionState.value).toBe("reconnecting");

      // Recovery sets connected immediately — no timer advance needed
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      expect(connectionState.value).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnect_attempt before grace window also debounces; reconnectAttempt still updated synchronously", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket, RECONNECTING_GRACE_MS } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit, __emitIo } = await import("socket.io-client");

      const { connectionState, reconnectAttempt, connect } = useSocket();
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "transport close",
      );

      // Advance partway
      vi.advanceTimersByTime(500);

      (__emitIo as unknown as (event: string, ...args: unknown[]) => void)(
        "reconnect_attempt",
        1,
      );

      // reconnectAttempt is updated synchronously
      expect(reconnectAttempt.value).toBe(1);

      // But banner not yet showing — still within grace window from first event
      expect(connectionState.value).toBe("connected");

      // Recovery arrives before grace window expires
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      expect(connectionState.value).toBe("connected");

      // Advance past original deadline — nothing fires (timer was cancelled)
      vi.advanceTimersByTime(RECONNECTING_GRACE_MS);
      expect(connectionState.value).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("deadline not pushed out by repeated reconnect_attempts (E4): banner surfaces at ~GRACE_MS from first event", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket, RECONNECTING_GRACE_MS } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit, __emitIo } = await import("socket.io-client");

      const { connectionState, connect } = useSocket();
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "transport close",
      );

      // Several reconnect_attempts spread over time — each should NOT push the deadline
      vi.advanceTimersByTime(500);
      (__emitIo as unknown as (event: string, ...args: unknown[]) => void)(
        "reconnect_attempt",
        1,
      );

      vi.advanceTimersByTime(500);
      (__emitIo as unknown as (event: string, ...args: unknown[]) => void)(
        "reconnect_attempt",
        2,
      );

      vi.advanceTimersByTime(500);
      (__emitIo as unknown as (event: string, ...args: unknown[]) => void)(
        "reconnect_attempt",
        3,
      );

      // Total elapsed: 1500ms — still under original 1750ms deadline
      expect(connectionState.value).toBe("connected");

      // Advance to exactly GRACE_MS from the original disconnect
      vi.advanceTimersByTime(RECONNECTING_GRACE_MS - 1500);
      expect(connectionState.value).toBe("reconnecting");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useSocket — terminal & teardown are not debounced (LLD 165)", () => {
  beforeEach(async () => {
    const { __resetListeners } = await import("socket.io-client");
    (__resetListeners as unknown as () => void)();
  });

  it("reconnect_failed is immediate (E5): terminal set synchronously, pending timer does not flip to reconnecting", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket, RECONNECTING_GRACE_MS } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit, __emitIo } = await import("socket.io-client");

      const { connectionState, connect } = useSocket();
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "transport close",
      );

      // Timer is now armed; fire reconnect_failed before it elapses
      (__emitIo as unknown as (event: string, ...args: unknown[]) => void)(
        "reconnect_failed",
      );

      // Terminal immediately — no timer advance needed
      expect(connectionState.value).toBe("terminal");

      // Advance past grace window — must NOT flip to "reconnecting"
      vi.advanceTimersByTime(RECONNECTING_GRACE_MS + 100);
      expect(connectionState.value).toBe("terminal");
    } finally {
      vi.useRealTimers();
    }
  });

  it("'io server disconnect' is terminal immediately, no timer advance needed", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket, RECONNECTING_GRACE_MS } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit } = await import("socket.io-client");

      const { connectionState, connect } = useSocket();
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "io server disconnect",
      );

      // Terminal immediately — no timer involved
      expect(connectionState.value).toBe("terminal");

      // Advance timers — stays terminal
      vi.advanceTimersByTime(RECONNECTING_GRACE_MS + 100);
      expect(connectionState.value).toBe("terminal");
    } finally {
      vi.useRealTimers();
    }
  });

  it("callback race guard (E6): connect clears timer, advancing timers afterwards stays 'connected'", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket, RECONNECTING_GRACE_MS } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit } = await import("socket.io-client");

      const { connectionState, connect } = useSocket();
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "transport close",
      );

      // connect fires — clears the timer
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      expect(connectionState.value).toBe("connected");

      // Advance past grace window — timer was cancelled, so nothing fires
      vi.advanceTimersByTime(RECONNECTING_GRACE_MS + 100);
      expect(connectionState.value).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("teardown clears the timer (E7): disconnect() prevents reconnecting from surfacing", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket, RECONNECTING_GRACE_MS } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit } = await import("socket.io-client");

      const { connectionState, connect, disconnect } = useSocket();
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "transport close",
      );

      // Timer is now armed; manually disconnect (teardown)
      disconnect();

      // Advance past grace window — timer was cleared, no "reconnecting" surfaces
      vi.advanceTimersByTime(RECONNECTING_GRACE_MS + 100);
      // connectionState was "connected" at teardown (timer had not yet fired)
      expect(connectionState.value).not.toBe("reconnecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("connect() reset clears a stale timer from a prior socket cycle", async () => {
    vi.useFakeTimers();
    try {
      const { useSocket, RECONNECTING_GRACE_MS } =
        await import("../../src/frontend/composables/useSocket.js");
      const { __emit } = await import("socket.io-client");

      const { connectionState, connect, disconnect } = useSocket();
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "disconnect",
        "transport close",
      );

      // Manually disconnect (clears timer and nulls socket)
      disconnect();

      // Start a fresh connection cycle
      await connect();

      (__emit as unknown as (event: string, ...args: unknown[]) => void)(
        "connect",
      );
      expect(connectionState.value).toBe("connected");

      // Advance past old timer deadline — should not fire reconnecting
      vi.advanceTimersByTime(RECONNECTING_GRACE_MS + 100);
      expect(connectionState.value).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });
});
