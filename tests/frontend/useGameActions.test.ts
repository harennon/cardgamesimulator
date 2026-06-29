import { describe, it, expect, vi } from "vitest";
import type { Card } from "../../src/shared/engine-types.js";
import type {
  GameStartResponse,
  GameActionResponse,
  GameRematchResponse,
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

  describe("rematch", () => {
    it("throws before bind", async () => {
      const { rematch } = useGameActions();
      await expect(rematch("game-1")).rejects.toThrow(
        "bind() must be called before emitting actions",
      );
    });

    it("emits game:rematch with the given gameId", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true, newGameId: "new-1" });
      });
      const { rematch, bind } = useGameActions();
      bind(socket);

      await rematch("game-42");

      expect(socket.emit).toHaveBeenCalledWith(
        "game:rematch",
        { gameId: "game-42" },
        expect.any(Function),
      );
    });

    it("returns success and newGameId on a successful response", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({
          success: true,
          newGameId: "new-1",
        } satisfies GameRematchResponse);
      });
      const { rematch, bind } = useGameActions();
      bind(socket);

      const result = await rematch("game-1");

      expect(result.success).toBe(true);
      expect(result.newGameId).toBe("new-1");
    });

    it("returns success: false and sets actionError on failure", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({
          success: false,
          error: "NOT_ENOUGH_PLAYERS",
        } satisfies GameRematchResponse);
      });
      const { rematch, actionError, bind } = useGameActions();
      bind(socket);

      const result = await rematch("game-1");

      expect(result.success).toBe(false);
      expect(actionError.value).toBe("NOT_ENOUGH_PLAYERS");
    });

    it("uses a fallback error message when the error field is absent", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: false } satisfies GameRematchResponse);
      });
      const { rematch, actionError, bind } = useGameActions();
      bind(socket);

      await rematch("game-1");

      expect(actionError.value).toBe("Failed to start rematch");
    });

    it("resets actionPending to false after completion", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true, newGameId: "new-1" });
      });
      const { rematch, actionPending, bind } = useGameActions();
      bind(socket);

      await rematch("game-1");

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

  describe("discard (Tonk)", () => {
    const tonkCards: Card[] = [
      { suit: "clubs", rank: "Q" },
      { suit: "diamonds", rank: "Q" },
      { suit: "spades", rank: "Q" },
    ];

    it("throws before bind", async () => {
      const { discard } = useGameActions();
      await expect(discard("game-1", tonkCards)).rejects.toThrow(
        "bind() must be called before emitting actions",
      );
    });

    it("emits game:action with discard type, the cards, and playerId ''", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { discard, bind } = useGameActions();
      bind(socket);

      await discard("game-1", tonkCards);

      expect(socket.emit).toHaveBeenCalledWith(
        "game:action",
        {
          gameId: "game-1",
          action: { type: "discard", cards: tonkCards, playerId: "" },
        },
        expect.any(Function),
      );
    });

    it("sends a copy of the cards array (not the caller's reference)", async () => {
      let sentCards: unknown;
      const { socket } = makeMockSocket((_, payload, ack) => {
        sentCards = (payload as { action: { cards: unknown } }).action.cards;
        ack({ success: true });
      });
      const { discard, bind } = useGameActions();
      bind(socket);

      await discard("game-1", tonkCards);

      expect(sentCards).toEqual(tonkCards);
      expect(sentCards).not.toBe(tonkCards);
    });

    it("returns success: true on a successful ack", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true } satisfies GameActionResponse);
      });
      const { discard, bind } = useGameActions();
      bind(socket);

      const result = await discard("game-1", tonkCards);

      expect(result.success).toBe(true);
    });

    it("sets actionError from a failed ack", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({
          success: false,
          error: "Discard must be a single rank.",
        } satisfies GameActionResponse);
      });
      const { discard, actionError, bind } = useGameActions();
      bind(socket);

      const result = await discard("game-1", tonkCards);

      expect(result.success).toBe(false);
      expect(actionError.value).toBe("Discard must be a single rank.");
    });

    it("uses the fallback 'Invalid discard' when error is absent", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: false } satisfies GameActionResponse);
      });
      const { discard, actionError, bind } = useGameActions();
      bind(socket);

      await discard("game-1", tonkCards);

      expect(actionError.value).toBe("Invalid discard");
    });

    it("resets actionPending to false after completion", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { discard, actionPending, bind } = useGameActions();
      bind(socket);

      await discard("game-1", tonkCards);

      expect(actionPending.value).toBe(false);
    });

    it("emits a joker discard payload unchanged", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { discard, bind } = useGameActions();
      bind(socket);

      const jokers = [
        { joker: true, id: 0 },
        { joker: true, id: 1 },
      ] as const;
      await discard("game-1", jokers);

      expect(socket.emit).toHaveBeenCalledWith(
        "game:action",
        {
          gameId: "game-1",
          action: { type: "discard", cards: [...jokers], playerId: "" },
        },
        expect.any(Function),
      );
    });
  });

  describe("drawCard (Tonk)", () => {
    it("throws before bind", async () => {
      const { drawCard } = useGameActions();
      await expect(drawCard("game-1", "stock")).rejects.toThrow(
        "bind() must be called before emitting actions",
      );
    });

    it("emits game:action with draw type and source 'stock'", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { drawCard, bind } = useGameActions();
      bind(socket);

      await drawCard("game-1", "stock");

      expect(socket.emit).toHaveBeenCalledWith(
        "game:action",
        {
          gameId: "game-1",
          action: { type: "draw", source: "stock", playerId: "" },
        },
        expect.any(Function),
      );
    });

    it("emits game:action with draw type and source 'discard'", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { drawCard, bind } = useGameActions();
      bind(socket);

      await drawCard("game-1", "discard");

      expect(socket.emit).toHaveBeenCalledWith(
        "game:action",
        {
          gameId: "game-1",
          action: { type: "draw", source: "discard", playerId: "" },
        },
        expect.any(Function),
      );
    });

    it("sets actionError from a failed ack", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: false, error: "Cannot draw" });
      });
      const { drawCard, actionError, bind } = useGameActions();
      bind(socket);

      await drawCard("game-1", "stock");

      expect(actionError.value).toBe("Cannot draw");
    });

    it("uses the fallback 'Cannot draw' when error is absent", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: false });
      });
      const { drawCard, actionError, bind } = useGameActions();
      bind(socket);

      await drawCard("game-1", "stock");

      expect(actionError.value).toBe("Cannot draw");
    });

    it("resets actionPending to false after completion", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { drawCard, actionPending, bind } = useGameActions();
      bind(socket);

      await drawCard("game-1", "stock");

      expect(actionPending.value).toBe(false);
    });
  });

  describe("callTonk", () => {
    it("throws before bind", async () => {
      const { callTonk } = useGameActions();
      await expect(callTonk("game-1")).rejects.toThrow(
        "bind() must be called before emitting actions",
      );
    });

    it("emits game:action with callTonk type and playerId ''", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { callTonk, bind } = useGameActions();
      bind(socket);

      await callTonk("game-1");

      expect(socket.emit).toHaveBeenCalledWith(
        "game:action",
        {
          gameId: "game-1",
          action: { type: "callTonk", playerId: "" },
        },
        expect.any(Function),
      );
    });

    it("sets actionError from a failed ack", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: false, error: "TONK gate is closed." });
      });
      const { callTonk, actionError, bind } = useGameActions();
      bind(socket);

      await callTonk("game-1");

      expect(actionError.value).toBe("TONK gate is closed.");
    });

    it("uses the fallback 'Cannot call TONK' when error is absent", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: false });
      });
      const { callTonk, actionError, bind } = useGameActions();
      bind(socket);

      await callTonk("game-1");

      expect(actionError.value).toBe("Cannot call TONK");
    });

    it("resets actionPending to false after completion", async () => {
      const { socket } = makeMockSocket((_, __, ack) => {
        ack({ success: true });
      });
      const { callTonk, actionPending, bind } = useGameActions();
      bind(socket);

      await callTonk("game-1");

      expect(actionPending.value).toBe(false);
    });
  });
});
