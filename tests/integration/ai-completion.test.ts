/**
 * LLD 122 — AI players hang after a human wins (reproduction + regression tests).
 *
 * Primary AC: after a human finishes first in a 1-human + 3-AI Big2 game with
 * a turn timer, the remaining AI seats must drive to COMPLETED synchronously
 * (no timer fire needed). On main (before the fix) the autoPlayAbandoned loop
 * bails out via B3 after playerCount*2 = 8 iterations while 3 AI seats still
 * hold cards → game stalls, timer fires, default pass is applied → re-stall.
 * After the fix the loop's completion-sized bound drives to COMPLETED inside
 * the action ack cycle with pendingCount === 0.
 *
 * Test strategy: use seed-state to place the game in a deterministic near-end
 * condition — human holds only [2♠] (highest card, free play), AI seats hold
 * many cards. The human's single play empties their hand, triggering the
 * completion path that exposed the bug.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import {
  createTestServer,
  type TestServerContext,
} from "./helpers/testServer.js";
import { createTestUser } from "./helpers/supabaseUser.js";
import {
  createAuthenticatedSocket,
  disconnectSocket,
  type TypedClientSocket,
} from "./helpers/socketClient.js";
import type { EnrichedPlayerView } from "../../src/shared/socket-events.js";
import type { InternalGameState } from "../../src/shared/engine-types.js";
import type { Big2State } from "../../src/backend/engine/big2/big2-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a game with numAiSeats AI players, join the human socket, start the
 * game, and return the game ID (game is now IN_PROGRESS).
 */
async function createAndStartAiGame(
  ctx: TestServerContext,
  humanToken: string,
  opts: {
    maxPlayers: number;
    numAiSeats: number;
    turnTimerSeconds: number;
  },
): Promise<{ gameId: string; socket: TypedClientSocket }> {
  const createRes = await request(ctx.app)
    .post("/createGame")
    .set("Authorization", `Bearer ${humanToken}`)
    .send({
      gameType: "big2",
      maxPlayers: opts.maxPlayers,
      turnTimerSeconds: opts.turnTimerSeconds,
      numAiSeats: opts.numAiSeats,
    });
  expect(createRes.status).toBe(200);
  const gameId = createRes.body.gameId as string;

  const socket = await createAuthenticatedSocket(ctx.baseUrl, humanToken);

  await new Promise<void>((resolve, reject) => {
    socket.emit("game:join", { gameId, role: "player" }, (ack) => {
      if (ack.success) resolve();
      else reject(new Error("game:join failed: " + ack.error));
    });
  });

  // Drain any game:state events that arrive before the start ack. We use once
  // here because the first game:state is the one right after game:start, and
  // after seeding we will re-register a fresh listener.
  const firstStatePromise = new Promise<EnrichedPlayerView>((resolve) => {
    socket.once("game:state", resolve);
  });

  await new Promise<void>((resolve, reject) => {
    socket.emit("game:start", { gameId }, (ack) => {
      if (ack.success) resolve();
      else reject(new Error("game:start failed: " + ack.error));
    });
  });

  // Wait for the initial game:state (ensures the game is fully started before seeding)
  await firstStatePromise;

  return { gameId, socket };
}

/**
 * Seed a near-end Big2 state: human at index 0 has only [2♠], AI seats at
 * 1..numAiSeats each hold 13 clubs. isFreePlay=true so the 2♠ is always valid.
 *
 * The seed endpoint merges over the started state, preserving players/randomSeed
 * and AI seat IDs — we only replace the gameSpecificState hands and turn info.
 */
async function seedNearEndState(
  ctx: TestServerContext,
  gameId: string,
  numAiSeats: number,
): Promise<void> {
  const human2Spade = [{ rank: "2", suit: "spades" }];
  const clubRanks = [
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
    "K",
    "A",
    "2",
  ] as const;
  // 13-card hand of clubs for each AI seat; 2♠ is excluded so no duplicates.
  const aiHand = Array.from({ length: 13 }, (_, i) => ({
    rank: clubRanks[i]!,
    suit: "clubs" as const,
  }));

  const hands = [
    human2Spade,
    ...Array.from({ length: numAiSeats }, () => aiHand),
  ];

  const big2State: Big2State = {
    hands,
    lastPlay: null,
    lastPlayPlayerIndex: null,
    consecutivePasses: 0,
    isFreePlay: true,
    isFirstPlayOfGame: false,
    playHistory: [],
    finishedPlayerIndices: [],
    trickStartIndex: 0,
  };

  const seedRes = await request(ctx.app)
    .post("/test/seed-state")
    .send({
      gameId,
      state: {
        status: "IN_PROGRESS",
        currentPlayerIndex: 0, // human's turn
        version: 50, // bump version so action validator doesn't reject
        gameSpecificState: big2State,
      } satisfies Partial<InternalGameState>,
    });
  expect(seedRes.status).toBe(200);
}

/**
 * Subscribe to game:state events via a queue so we never miss an update that
 * arrives before the next await.
 */
function makeStateQueue(socket: TypedClientSocket): {
  next: () => Promise<EnrichedPlayerView>;
  cancel: () => void;
} {
  const pending: EnrichedPlayerView[] = [];
  const resolvers: Array<(v: EnrichedPlayerView) => void> = [];
  let cancelled = false;

  const handler = (state: EnrichedPlayerView): void => {
    if (cancelled) return;
    if (resolvers.length > 0) {
      resolvers.shift()!(state);
    } else {
      pending.push(state);
    }
  };
  socket.on("game:state", handler);

  return {
    next: () =>
      new Promise<EnrichedPlayerView>((resolve) => {
        if (pending.length > 0) {
          resolve(pending.shift()!);
        } else {
          resolvers.push(resolve);
        }
      }),
    cancel: () => {
      cancelled = true;
      socket.off("game:state", handler);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AI completion — human wins first, AI seats play out (LLD 122)", () => {
  /**
   * Primary reproduction test.
   *
   * Scenario: 4-player Big2 (1 human + 3 AI) with turnTimerSeconds: 30.
   * Game is seeded so the human holds only [2♠] (a free play) and 3 AI seats
   * each hold 13 cards. The human plays the 2♠, empties their hand, and the
   * remaining 3 AI seats must play out to determine 2nd/3rd/4th placement.
   *
   * Failure mode on main (before fix): autoPlayAbandoned exits via B3 after
   * playerCount*2 = 8 iterations while AI seats still hold many cards. The AI
   * seat is left current with a stale timer — the game hangs for ~30s until the
   * timer fires. timerExpired is received, game re-stalls, and so on.
   *
   * After the fix: loop drives all remaining AI seats to COMPLETED synchronously
   * inside the action ack cycle; no timer fires; pendingCount === 0.
   */
  it("1-human + 3-AI Big2: seeded near-end state → COMPLETED synchronously after human's last play", async () => {
    const localCtx = await createTestServer();
    const human = await createTestUser("AICompletionHuman4P");

    const timerExpiredEvents: unknown[] = [];

    try {
      // 1. Create game, join, start (gives us a valid game state + AI seat IDs).
      const { gameId, socket } = await createAndStartAiGame(
        localCtx,
        human.accessToken,
        { maxPlayers: 4, numAiSeats: 3, turnTimerSeconds: 30 },
      );
      socket.on("game:timerExpired", (p) => timerExpiredEvents.push(p));

      // 2. Seed the near-end state: human has [2♠], AI seats have 13 cards each.
      await seedNearEndState(localCtx, gameId, 3);

      // 3. Set up state queue to capture all broadcasts after the human's action.
      const stateQueue = makeStateQueue(socket);

      // 4. Human plays the 2♠. This triggers autoPlayAbandoned for 3 AI seats.
      const playAck = await new Promise<{ success: boolean; error?: string }>(
        (resolve) => {
          socket.emit(
            "game:action",
            {
              gameId,
              action: {
                type: "playCards",
                playerId: human.id,
                cards: [{ rank: "2", suit: "spades" }],
              },
            },
            (ack) => resolve(ack),
          );
        },
      );
      expect(playAck.success).toBe(true);

      // 5. Collect states until COMPLETED or a reasonable max.
      //    The fix drives to COMPLETED synchronously — so we should get there
      //    within a few state broadcasts without any timer fire.
      let finalView: EnrichedPlayerView | null = null;
      for (let i = 0; i < 200; i++) {
        const view = await stateQueue.next();
        if (view.status === "COMPLETED") {
          finalView = view;
          break;
        }
      }

      // (a) No timer fired at any point.
      expect(timerExpiredEvents).toHaveLength(0);

      // (b) Game must be COMPLETED with winner and scores.
      expect(finalView).not.toBeNull();
      expect(finalView!.status).toBe("COMPLETED");
      expect(finalView!.winner).not.toBeNull();
      expect(finalView!.scores).not.toBeNull();

      // (c) Timer unregistered; no pending timers after synchronous completion.
      expect(localCtx.turnTimerService.hasTimer(gameId)).toBe(false);
      expect(localCtx.turnTimerService.getDeadline(gameId)).toBeNull();
      expect(localCtx.timerProvider.pendingCount).toBe(0);

      stateQueue.cancel();
      disconnectSocket(socket);
    } finally {
      await localCtx.close();
    }
  }, 60_000);

  /**
   * Last-two-players completion path: 2-player game (1 human + 1 AI).
   * Seeded so human has [2♠] and AI has 13 clubs. Human plays the 2♠ and the
   * game must complete synchronously (2-player Big2 ends when first player
   * empties hand since activePlayers drops to 1).
   */
  it("2-player game (1 human + 1 AI): seeded near-end state → COMPLETED after human's last play", async () => {
    const localCtx = await createTestServer();
    const human = await createTestUser("AICompletion2P");

    const timerExpiredEvents: unknown[] = [];

    try {
      const { gameId, socket } = await createAndStartAiGame(
        localCtx,
        human.accessToken,
        { maxPlayers: 2, numAiSeats: 1, turnTimerSeconds: 30 },
      );
      socket.on("game:timerExpired", (p) => timerExpiredEvents.push(p));

      await seedNearEndState(localCtx, gameId, 1);

      const stateQueue = makeStateQueue(socket);

      const playAck = await new Promise<{ success: boolean; error?: string }>(
        (resolve) => {
          socket.emit(
            "game:action",
            {
              gameId,
              action: {
                type: "playCards",
                playerId: human.id,
                cards: [{ rank: "2", suit: "spades" }],
              },
            },
            (ack) => resolve(ack),
          );
        },
      );
      expect(playAck.success).toBe(true);

      // 2-player: when human empties their hand, activePlayers drops to 1 →
      // COMPLETED immediately without any AI play needed.
      // The first state from handleGameAction should already be COMPLETED.
      let finalView: EnrichedPlayerView | null = null;
      for (let i = 0; i < 10; i++) {
        const view = await stateQueue.next();
        if (view.status === "COMPLETED") {
          finalView = view;
          break;
        }
      }

      expect(timerExpiredEvents).toHaveLength(0);
      expect(finalView).not.toBeNull();
      expect(finalView!.status).toBe("COMPLETED");
      expect(localCtx.turnTimerService.hasTimer(gameId)).toBe(false);
      expect(localCtx.timerProvider.pendingCount).toBe(0);

      stateQueue.cancel();
      disconnectSocket(socket);
    } finally {
      await localCtx.close();
    }
  }, 60_000);
});
