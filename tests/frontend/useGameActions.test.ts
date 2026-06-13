import { describe, it, expect, vi } from "vitest";
import type { Card } from "../../src/shared/engine-types.js";
import type {
  GameStartResponse,
  GameActionResponse,
} from "../../src/shared/socket-events.js";
import type { TypedClientSocket } from "../../src/frontend/composables/useSocket.js";
import { useGameActions } from "../../src/frontend/composables/useGameActions.js";

type EmitHandler = (
  event: string,
  payload: unknown,
  ack: (response: unknown) => void,
) => void;

function makeMockSocket(emitImpl?: EmitHandler): { socket: TypedClientSocket } {
  const socket = {
    emit: vi.fn(
      (event: string, payload: unknown, ack: (r: unknown) => void) => {
        emitImpl?.(event, payload, ack);
      },
    ),
  } as unknown as TypedClientSocket;
  return { socket };
}

const sampleCards: Card[] = [
  { suit: "clubs", rank: "3" },
  { suit: "diamonds", rank: "4" },
];

describe("useGameActions", () => {
  describe("initial state", () => {
    it("starts with null actionError", () => {
      const { actionError } = useGameActions();
      expect(actionError.value).toBeNull();
    });

    it("starts with actionPending false", () => {
      const { actionPending } = useGameActions();
      expect(actionPending.value).toBe(false);
    });
  });

  describe("bind / unbind", () => {
    it("startGame throws before bind", async () => {
      const { startGame } = useGameActions();
      await expect(startGame("game-1")).rejects.toThrow(
        "bind() must be called before emitting actions",
      );
    });

    it("playCards throws before bind", async () => {
      const { playCards } = useGameActions();
      await expect(playCards("game-1", sampleCards)).rejects.toThrow(
        "bind() must be called before emitting actions",
      );
    });

    it("pass throws before bind", async () => {
      const { pass } = useGameActions();
      await expect(pass("game-1")).rejects.toThrow(
        "bind() must be called before emitting actions",
      );
    });

    it("actions throw after unbind", async () => {
      const { socket } = makeMockSocket();
      const { startGame, bind, unbind } = useGameActions();

      bind(socket);
      unbind();

      await expect(startGame("game-1")).rejects.toThrow(
        "bind() must be called before emitting actions",
      );
    });

    it("unbind is safe to call before bind", () => {
      const { unbind } = useGameActions();
      expect(() => unbind()).not.toThrow();
    });
  });

  describe("startGame", () => {
    it("emits game:start with the given gameId", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { startGame, bind } = useGameActions();
      bind(socket);

      await startGame("game-42");

      expect(socket.emit).toHaveBeenCalledWith(
        "game:start",
        { gameId: "game-42" },
        expect.any(Function),
      );
    });

    it("returns success: true on successful response", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true } satisfies GameStartResponse);
      });
      const { startGame, bind } = useGameActions();
      bind(socket);

      const result = await startGame("game-1");

      expect(result.success).toBe(true);
    });

    it("returns success: false and sets actionError on failure", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({
          success: false,
          error: "Not enough players",
        } satisfies GameStartResponse);
      });
      const { startGame, actionError, bind } = useGameActions();
      bind(socket);

      const result = await startGame("game-1");

      expect(result.success).toBe(false);
      expect(actionError.value).toBe("Not enough players");
    });

    it("sets a fallback error message when error field is absent", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: false } satisfies GameStartResponse);
      });
      const { startGame, actionError, bind } = useGameActions();
      bind(socket);

      await startGame("game-1");

      expect(actionError.value).toBe("Failed to start game");
    });

    it("clears actionError before emitting", async () => {
      let callCount = 0;
      const { socket } = makeMockSocket((_, __, ack) => {
        callCount++;
        ack(
          callCount === 1
            ? { success: false, error: "first error" }
            : { success: true },
        );
      });
      const { startGame, actionError, bind } = useGameActions();
      bind(socket);

      await startGame("game-1");
      expect(actionError.value).toBe("first error");

      await startGame("game-1");
      expect(actionError.value).toBeNull();
    });

    it("resets actionPending to false after success", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { startGame, actionPending, bind } = useGameActions();
      bind(socket);

      await startGame("game-1");

      expect(actionPending.value).toBe(false);
    });

    it("resets actionPending to false after failure", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: false, error: "oops" });
      });
      const { startGame, actionPending, bind } = useGameActions();
      bind(socket);

      await startGame("game-1");

      expect(actionPending.value).toBe(false);
    });
  });

  describe("playCards", () => {
    it("emits game:action with playCards type and given cards", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { playCards, bind } = useGameActions();
      bind(socket);

      await playCards("game-1", sampleCards);

      expect(socket.emit).toHaveBeenCalledWith(
        "game:action",
        expect.objectContaining({
          gameId: "game-1",
          action: expect.objectContaining({
            type: "playCards",
            cards: sampleCards,
          }),
        }),
        expect.any(Function),
      );
    });

    it("returns success: true on successful response", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true } satisfies GameActionResponse);
      });
      const { playCards, bind } = useGameActions();
      bind(socket);

      const result = await playCards("game-1", sampleCards);

      expect(result.success).toBe(true);
    });

    it("returns success: false and sets actionError on rejection", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({
          success: false,
          error: "Invalid play",
        } satisfies GameActionResponse);
      });
      const { playCards, actionError, bind } = useGameActions();
      bind(socket);

      const result = await playCards("game-1", sampleCards);

      expect(result.success).toBe(false);
      expect(actionError.value).toBe("Invalid play");
    });

    it("uses fallback error message when error field is absent", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: false } satisfies GameActionResponse);
      });
      const { playCards, actionError, bind } = useGameActions();
      bind(socket);

      await playCards("game-1", sampleCards);

      expect(actionError.value).toBe("Invalid play");
    });

    it("resets actionPending to false after completion", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { playCards, actionPending, bind } = useGameActions();
      bind(socket);

      await playCards("game-1", sampleCards);

      expect(actionPending.value).toBe(false);
    });
  });

  describe("pass", () => {
    it("emits game:action with pass type", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { pass, bind } = useGameActions();
      bind(socket);

      await pass("game-1");

      expect(socket.emit).toHaveBeenCalledWith(
        "game:action",
        expect.objectContaining({
          gameId: "game-1",
          action: expect.objectContaining({ type: "pass" }),
        }),
        expect.any(Function),
      );
    });

    it("returns success: true on successful response", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true } satisfies GameActionResponse);
      });
      const { pass, bind } = useGameActions();
      bind(socket);

      const result = await pass("game-1");

      expect(result.success).toBe(true);
    });

    it("returns success: false and sets actionError on failure", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({
          success: false,
          error: "Cannot pass",
        } satisfies GameActionResponse);
      });
      const { pass, actionError, bind } = useGameActions();
      bind(socket);

      const result = await pass("game-1");

      expect(result.success).toBe(false);
      expect(actionError.value).toBe("Cannot pass");
    });

    it("uses fallback error message when error field is absent", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: false } satisfies GameActionResponse);
      });
      const { pass, actionError, bind } = useGameActions();
      bind(socket);

      await pass("game-1");

      expect(actionError.value).toBe("Cannot pass");
    });

    it("resets actionPending to false after completion", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { pass, actionPending, bind } = useGameActions();
      bind(socket);

      await pass("game-1");

      expect(actionPending.value).toBe(false);
    });
  });
});
