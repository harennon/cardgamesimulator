import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("socket.io-client", () => {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const mockSocket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? [];
      listeners.set(event, [...existing, handler]);
    }),
    off: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
  };

  function emit(event: string, ...args: unknown[]): void {
    const handlers = listeners.get(event) ?? [];
    for (const h of handlers) {
      h(...args);
    }
  }

  return {
    io: vi.fn(() => mockSocket),
    __mockSocket: mockSocket,
    __emit: emit,
    __resetListeners: () => listeners.clear(),
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

describe("useSocket — SERVER_FULL handling", () => {
  beforeEach(async () => {
    const { __resetListeners } = await import("socket.io-client");
    (__resetListeners as unknown as () => void)();
    const { __mockSocket } = await import("socket.io-client");
    (
      __mockSocket as unknown as { disconnect: ReturnType<typeof vi.fn> }
    ).disconnect.mockClear();
  });

  it("sets human-readable error and disconnects on SERVER_FULL", async () => {
    const { useSocket } =
      await import("../../src/frontend/composables/useSocket.js");
    const { __emit, __mockSocket } = await import("socket.io-client");

    const { socket, error, connected, connect } = useSocket();
    await connect();

    expect(socket.value).not.toBeNull();

    (__emit as unknown as (event: string, ...args: unknown[]) => void)(
      "connect_error",
      new Error("SERVER_FULL"),
    );

    expect(error.value).toBe(
      "Server is at capacity. Please try again shortly.",
    );
    expect(connected.value).toBe(false);
    expect(
      (__mockSocket as unknown as { disconnect: ReturnType<typeof vi.fn> })
        .disconnect,
    ).toHaveBeenCalled();
  });

  it("does not disconnect on other connect errors", async () => {
    const { useSocket } =
      await import("../../src/frontend/composables/useSocket.js");
    const { __emit, __mockSocket } = await import("socket.io-client");

    const { error, connect } = useSocket();
    await connect();

    (__emit as unknown as (event: string, ...args: unknown[]) => void)(
      "connect_error",
      new Error("timeout"),
    );

    expect(error.value).toBe("timeout");
    expect(
      (__mockSocket as unknown as { disconnect: ReturnType<typeof vi.fn> })
        .disconnect,
    ).not.toHaveBeenCalled();
  });
});
