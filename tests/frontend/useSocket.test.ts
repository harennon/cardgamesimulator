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

  it("connectionState transitions to 'reconnecting' on disconnect(transport close)", async () => {
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
      "transport close",
    );

    expect(connectionState.value).toBe("reconnecting");
  });

  it("connectionState transitions to 'connected' on reconnect", async () => {
    const { useSocket } =
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
    (__emit as unknown as (event: string, ...args: unknown[]) => void)(
      "connect",
    );

    expect(connectionState.value).toBe("connected");
    expect(reconnectAttempt.value).toBe(0);
  });

  it("connectionState transitions to 'terminal' on reconnect_failed", async () => {
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

    expect(reconnectAttempt.value).toBe(3);
  });
});
