import { describe, it, expect, vi } from "vitest";
import type { PlayerView } from "../../src/shared/engine-types.js";
import type { TypedClientSocket } from "../../src/frontend/composables/useSocket.js";
import { useGameState } from "../../src/frontend/composables/useGameState.js";

function makePlayerView(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    gameId: "game-1",
    gameType: "big2",
    status: "IN_PROGRESS",
    version: 1,
    players: [],
    you: { playerId: "p1", displayName: "Player 1", hand: [] },
    currentPlayerIndex: 0,
    turnNumber: 1,
    validActions: [],
    gameSpecificPublicState: null,
    winner: null,
    scores: null,
    ...overrides,
  };
}

function makeMockSocket(): {
  socket: TypedClientSocket;
  emit: (event: string, payload: unknown) => void;
  listeners: Map<string, ((...args: unknown[]) => void)[]>;
} {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  const socket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? [];
      listeners.set(event, [...existing, handler]);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? [];
      listeners.set(
        event,
        existing.filter((h) => h !== handler),
      );
    }),
  } as unknown as TypedClientSocket;

  function emit(event: string, payload: unknown): void {
    const handlers = listeners.get(event) ?? [];
    for (const h of handlers) {
      h(payload);
    }
  }

  return { socket, emit, listeners };
}

describe("useGameState", () => {
  describe("initial state", () => {
    it("starts with null gameState", () => {
      const { gameState } = useGameState();
      expect(gameState.value).toBeNull();
    });

    it("starts with null status", () => {
      const { status } = useGameState();
      expect(status.value).toBeNull();
    });

    it("starts uninitialized", () => {
      const { initialized } = useGameState();
      expect(initialized.value).toBe(false);
    });
  });

  describe("bind", () => {
    it("registers a game:state listener on the socket", () => {
      const { socket, listeners } = makeMockSocket();
      const { bind } = useGameState();

      bind(socket);

      expect(listeners.get("game:state")).toHaveLength(1);
    });

    it("does not register listeners before bind is called", () => {
      const { listeners } = makeMockSocket();
      useGameState();
      expect((listeners.get("game:state") ?? []).length).toBe(0);
    });
  });

  describe("state updates from game:state events", () => {
    it("updates gameState when the socket emits game:state", () => {
      const { socket, emit } = makeMockSocket();
      const { gameState, bind } = useGameState();

      bind(socket);
      const view = makePlayerView();
      emit("game:state", view);

      expect(gameState.value).toEqual(view);
    });

    it("updates status from the received view", () => {
      const { socket, emit } = makeMockSocket();
      const { status, bind } = useGameState();

      bind(socket);
      emit("game:state", makePlayerView({ status: "IN_PROGRESS" }));

      expect(status.value).toBe("IN_PROGRESS");
    });

    it("sets initialized to true after first game:state event", () => {
      const { socket, emit } = makeMockSocket();
      const { initialized, bind } = useGameState();

      bind(socket);
      emit("game:state", makePlayerView());

      expect(initialized.value).toBe(true);
    });

    it("updates gameState on subsequent events", () => {
      const { socket, emit } = makeMockSocket();
      const { gameState, status, bind } = useGameState();

      bind(socket);
      emit("game:state", makePlayerView({ status: "IN_PROGRESS", version: 1 }));
      emit("game:state", makePlayerView({ status: "COMPLETED", version: 2 }));

      expect(gameState.value?.version).toBe(2);
      expect(status.value).toBe("COMPLETED");
    });
  });

  describe("unbind", () => {
    it("removes the game:state listener from the socket", () => {
      const { socket, listeners } = makeMockSocket();
      const { bind, unbind } = useGameState();

      bind(socket);
      unbind();

      expect((listeners.get("game:state") ?? []).length).toBe(0);
    });

    it("stops processing events after unbind", () => {
      const { socket, emit } = makeMockSocket();
      const { gameState, bind, unbind } = useGameState();

      bind(socket);
      unbind();
      emit("game:state", makePlayerView());

      expect(gameState.value).toBeNull();
    });

    it("unbind is safe to call before bind", () => {
      const { unbind } = useGameState();
      expect(() => unbind()).not.toThrow();
    });

    it("unbind is safe to call multiple times", () => {
      const { socket } = makeMockSocket();
      const { bind, unbind } = useGameState();

      bind(socket);
      unbind();
      expect(() => unbind()).not.toThrow();
    });
  });

  describe("gameState is readonly", () => {
    it("gameState value cannot be set from outside — write is silently rejected", () => {
      const { gameState } = useGameState();
      // Vue readonly() warns and silently ignores writes rather than throwing.
      // @ts-expect-error — intentionally testing readonly enforcement
      gameState.value = makePlayerView();
      expect(gameState.value).toBeNull();
    });
  });
});
