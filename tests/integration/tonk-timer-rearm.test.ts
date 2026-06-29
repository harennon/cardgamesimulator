import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import {
  createTestServer,
  type TestServerContext,
} from "./helpers/testServer.js";
import { createTestUser, type TestUser } from "./helpers/supabaseUser.js";
import {
  createAuthenticatedSocket,
  disconnectSocket,
  type TypedClientSocket,
} from "./helpers/socketClient.js";
import type {
  InternalGameState,
  Rank,
  Suit,
} from "../../src/shared/engine-types.js";
import type { TonkState } from "../../src/backend/engine/tonk/tonk-types.js";
import type { TonkCard } from "../../src/shared/tonk-types.js";

// ---------------------------------------------------------------------------
// LLD 98: Tonk multi-phase turn-timer re-arm.
//
// Proves the WS timeout / auto-play infrastructure drives BOTH phases of a Tonk
// turn (discard then draw) for the same seat without stalling:
//   - T1/T2: a connected AFK seat auto-discards then auto-draws across two timer
//     fires; the seat does not advance on the discard fire.
//   - T3:    N consecutive abandoned seats are fully auto-played through both
//     phases; the timer is armed for the first connected seat. (Red against the
//     old players.length cap, green after the players.length * 2 cap.)
//   - T4:    abandoned seats play through to game completion (stock-out trick
//     that pushes a tally past LOSE_THRESHOLD); timer unregistered, abandoned
//     cleared.
//
// All preconditions are constructed directly via POST /test/seed-state per the
// "direct state manipulation over replay" principle (no Tonk action UI exists).
// ---------------------------------------------------------------------------

function card(rank: Rank, suit: Suit): TonkCard {
  return { rank, suit } as unknown as TonkCard;
}

/** Total cards across all hands + stock + discard — must be conserved per action. */
function totalCards(t: TonkState): number {
  const inHands = t.hands.reduce((sum, h) => sum + h.length, 0);
  return inHands + t.stock.length + t.discardPile.length;
}

async function createTonkGame(
  ctx: TestServerContext,
  users: TestUser[],
  maxPlayers: number,
): Promise<string> {
  const createRes = await request(ctx.app)
    .post("/createGame")
    .set("Authorization", `Bearer ${users[0]!.accessToken}`)
    .send({ gameType: "tonk", maxPlayers, turnTimerSeconds: 30 });
  expect(createRes.status).toBe(200);
  const gameId = createRes.body.gameId as string;

  for (const user of users.slice(1)) {
    const joinRes = await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ gameId });
    expect(joinRes.status).toBe(200);
  }
  return gameId;
}

/** Connect every user as a player and join the game room. */
async function connectSockets(
  ctx: TestServerContext,
  users: TestUser[],
  gameId: string,
): Promise<TypedClientSocket[]> {
  const sockets = await Promise.all(
    users.map((u) => createAuthenticatedSocket(ctx.baseUrl, u.accessToken)),
  );
  await Promise.all(
    sockets.map(
      (socket) =>
        new Promise<void>((resolve, reject) => {
          socket.emit("game:join", { gameId, role: "player" }, (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`game:join failed: ${ack.error}`));
          });
        }),
    ),
  );
  return sockets;
}

/** Start the game (registers + starts the timer). Returns the started state. */
async function startGame(
  sockets: TypedClientSocket[],
  gameId: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sockets[0]!.emit("game:start", { gameId }, (ack) => {
      if (ack.success) resolve();
      else reject(new Error(`game:start failed: ${ack.error}`));
    });
  });
}

/**
 * Overwrite the cached Tonk state with a deterministic precondition. The seed
 * endpoint merges over the started state, so players/randomSeed are preserved.
 */
async function seedTonkState(
  ctx: TestServerContext,
  gameId: string,
  currentPlayerIndex: number,
  tonk: TonkState,
): Promise<void> {
  const res = await request(ctx.app)
    .post("/test/seed-state")
    .send({
      gameId,
      state: {
        status: "IN_PROGRESS",
        currentPlayerIndex,
        version: 5,
        gameSpecificState: tonk,
      } satisfies Partial<InternalGameState>,
    });
  expect(res.status).toBe(200);
}

/** A baseline Tonk state with healthy stock so auto-draws never stock-out. */
function baseTonkState(playerCount: number, hands: TonkCard[][]): TonkState {
  // Stock large enough to absorb every auto-draw in the chain without exhausting.
  const stock: TonkCard[] = Array.from({ length: 12 }, (_v, i) =>
    card("5", (["clubs", "diamonds", "hearts", "spades"] as const)[i % 4]!),
  );
  return {
    hands,
    stock,
    discardPile: [card("3", "clubs")],
    drawableDiscard: card("3", "clubs"),
    lastDiscardCount: 1,
    lastDiscardPlayerIndex: null,
    turnPhase: "discard",
    trickNumber: 1,
    trickTurnCount: 0,
    tallies: Array.from({ length: playerCount }, () => 0),
    tonkCallerIndex: null,
    lostPlayerIndices: [],
    trueLoserIndex: null,
    trickDeckSize: 999,
    log: [],
  };
}

function tonkOf(state: InternalGameState): TonkState {
  return state.gameSpecificState as TonkState;
}

describe("LLD 98: Tonk multi-phase turn-timer re-arm", () => {
  // A fresh server (and fresh FakeTimerProvider) per test so global pending-timer
  // counts reflect only this test's game — no cross-test timer bleed.
  let ctx: TestServerContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  afterEach(async () => {
    await ctx.close();
  });

  // T1 + T2 -----------------------------------------------------------------
  it("connected AFK Tonk seat auto-discards then auto-draws across two timer fires; turn does not stall (T1/T2)", async () => {
    const users = await Promise.all([
      createTestUser("TonkRearmA1"),
      createTestUser("TonkRearmB1"),
      createTestUser("TonkRearmC1"),
    ]);
    const gameId = await createTonkGame(ctx, users, 4);
    const sockets = await connectSockets(ctx, users, gameId);

    try {
      await startGame(sockets, gameId);

      // Seat 0 connected, discard phase, multi-card hand so draw stays valid.
      const hands: TonkCard[][] = [
        [card("K", "spades"), card("4", "clubs"), card("7", "hearts")],
        [card("9", "diamonds"), card("2", "spades")],
        [card("6", "clubs"), card("8", "hearts")],
      ];
      const tonk = baseTonkState(3, hands);
      await seedTonkState(ctx, gameId, 0, tonk);

      const before = (await ctx.gameService.getGameState(gameId))!;
      const totalBefore = totalCards(tonkOf(before));
      expect(tonkOf(before).turnPhase).toBe("discard");
      expect(before.currentPlayerIndex).toBe(0);

      // --- Fire 1: auto-discard ---
      const afterDiscardPromise = new Promise<void>((resolve) => {
        sockets[1]!.once("game:state", () => resolve());
      });
      const firedFirst = ctx.timerProvider.fireAll();
      expect(firedFirst).toBe(1);
      await afterDiscardPromise;

      const afterDiscard = (await ctx.gameService.getGameState(gameId))!;
      const tDiscard = tonkOf(afterDiscard);
      // T2 invariant: the seat does NOT advance on the discard fire.
      expect(afterDiscard.currentPlayerIndex).toBe(0);
      expect(tDiscard.turnPhase).toBe("draw");
      // Hand shrank by exactly one; total cards conserved.
      expect(tDiscard.hands[0]!.length).toBe(hands[0]!.length - 1);
      expect(totalCards(tDiscard)).toBe(totalBefore);
      // Timer re-armed for the SAME seat — no stall.
      expect(ctx.timerProvider.pendingCount).toBe(1);
      expect(ctx.turnTimerService.getDeadline(gameId)).not.toBeNull();

      // --- Fire 2: auto-draw advances the seat ---
      const afterDrawPromise = new Promise<void>((resolve) => {
        sockets[1]!.once("game:state", () => resolve());
      });
      const firedSecond = ctx.timerProvider.fireAll();
      expect(firedSecond).toBe(1);
      await afterDrawPromise;

      const afterDraw = (await ctx.gameService.getGameState(gameId))!;
      const tDraw = tonkOf(afterDraw);
      // Seat advanced via nextSeat; back to discard phase for the new seat.
      expect(afterDraw.currentPlayerIndex).toBe(1);
      expect(tDraw.turnPhase).toBe("discard");
      // Drew one from stock; total conserved.
      expect(tDraw.hands[0]!.length).toBe(hands[0]!.length); // -1 discard +1 draw
      expect(totalCards(tDraw)).toBe(totalBefore);
      // Not stalled: timer armed for the next seat, game still in progress.
      expect(afterDraw.status).toBe("IN_PROGRESS");
      expect(ctx.timerProvider.pendingCount).toBe(1);
      expect(ctx.turnTimerService.getDeadline(gameId)).not.toBeNull();
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  // T3 ----------------------------------------------------------------------
  it("N consecutive abandoned Tonk seats are fully auto-played through both phases; timer armed for first connected seat (T3)", async () => {
    const users = await Promise.all([
      createTestUser("TonkAbandA"),
      createTestUser("TonkAbandB"),
      createTestUser("TonkAbandC"),
      createTestUser("TonkAbandD"),
    ]);
    const gameId = await createTonkGame(ctx, users, 4);
    const sockets = await connectSockets(ctx, users, gameId);

    try {
      await startGame(sockets, gameId);

      // Seats 0,1,2 disconnect + are abandoned; seat 3 stays connected.
      for (const idx of [0, 1, 2]) {
        const disconnected = new Promise<void>((resolve) => {
          sockets[3]!.once("game:playerDisconnected", () => resolve());
        });
        sockets[idx]!.disconnect();
        await disconnected;
        ctx.connectionManager.markAbandoned(gameId, users[idx]!.id);
      }
      for (const idx of [0, 1, 2]) {
        expect(ctx.connectionManager.isAbandoned(gameId, users[idx]!.id)).toBe(
          true,
        );
      }

      // Current = seat 0, discard phase. Each abandoned seat owns ≥2 cards so
      // discard leaves a card and the following draw is valid.
      const hands: TonkCard[][] = [
        [card("K", "spades"), card("4", "clubs")],
        [card("Q", "hearts"), card("5", "diamonds")],
        [card("J", "clubs"), card("6", "spades")],
        [card("9", "hearts"), card("3", "diamonds")],
      ];
      const tonk = baseTonkState(4, hands);
      await seedTonkState(ctx, gameId, 0, tonk);

      // Trigger the production path: fire the timer for the (abandoned) seat 0.
      // handleTimerExpired discards for seat 0, then autoPlayAbandoned drives the
      // rest. Poll the authoritative service state until the chain settles on the
      // connected seat (3) with a timer armed. Bounded so the buggy-cap stall
      // (no timer ever armed) fails fast rather than hanging the whole test.
      ctx.timerProvider.fireAll();
      const pollDeadline = Date.now() + 3000;
      let settledState = (await ctx.gameService.getGameState(gameId))!;
      while (
        ctx.turnTimerService.getDeadline(gameId) === null &&
        settledState.status === "IN_PROGRESS" &&
        Date.now() < pollDeadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
        settledState = (await ctx.gameService.getGameState(gameId))!;
      }
      const tSettled = tonkOf(settledState);

      // Loop reached the first connected seat (3) — not stalled on an abandoned seat.
      expect(settledState.status).toBe("IN_PROGRESS");
      expect(settledState.currentPlayerIndex).toBe(3);
      expect(ctx.connectionManager.isAbandoned(gameId, users[3]!.id)).toBe(
        false,
      );

      // Core anti-stall invariant: settled on a non-abandoned seat WITH a timer armed.
      expect(ctx.turnTimerService.getDeadline(gameId)).not.toBeNull();
      expect(ctx.timerProvider.pendingCount).toBe(1);

      // Each abandoned seat (0,1,2) produced a discard AND a draw log entry.
      for (const idx of [0, 1, 2]) {
        const pid = users[idx]!.id;
        const discards = tSettled.log.filter(
          (e) => e.playerId === pid && e.type === "discard",
        );
        const draws = tSettled.log.filter(
          (e) => e.playerId === pid && e.type === "draw",
        );
        expect(discards.length).toBeGreaterThanOrEqual(1);
        expect(draws.length).toBeGreaterThanOrEqual(1);
      }
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  // T4 ----------------------------------------------------------------------
  it("abandoned Tonk seats play through to game completion mid-loop; timer unregistered and abandoned cleared (T4 / E3)", async () => {
    const users = await Promise.all([
      createTestUser("TonkCompleteA"),
      createTestUser("TonkCompleteB"),
      createTestUser("TonkCompleteC"),
    ]);
    const gameId = await createTonkGame(ctx, users, 3);
    const sockets = await connectSockets(ctx, users, gameId);

    try {
      await startGame(sockets, gameId);

      // All three seats disconnect + abandoned.
      for (const idx of [0, 1, 2]) {
        sockets[idx]!.disconnect();
      }
      await new Promise((r) => setTimeout(r, 100));
      for (const idx of [0, 1, 2]) {
        ctx.connectionManager.markAbandoned(gameId, users[idx]!.id);
      }

      // Seat 0 current, discard phase, EMPTY stock. After seat 0's auto-discard
      // (handleTimerExpired), autoPlayAbandoned's auto-draw on the empty stock
      // ends the trick (stock-out). Seat 0 holds only zero-value jokers, so it is
      // uniquely lowest and takes the +30 Case-C penalty; its tally 130 -> 160
      // crosses LOSE_THRESHOLD (150) -> match COMPLETED mid-loop.
      const joker0: TonkCard = { joker: true, id: 0 } as unknown as TonkCard;
      const joker1: TonkCard = { joker: true, id: 1 } as unknown as TonkCard;
      const hands: TonkCard[][] = [
        [joker0, joker1],
        [card("K", "spades"), card("Q", "hearts")],
        [card("J", "clubs"), card("10", "diamonds")],
      ];
      const tonk: TonkState = {
        ...baseTonkState(3, hands),
        stock: [],
        tallies: [130, 10, 20],
        trickTurnCount: 3,
      };
      await seedTonkState(ctx, gameId, 0, tonk);

      // Fire the timer for the abandoned seat 0. All player sockets are
      // disconnected, so poll the authoritative service state for completion.
      ctx.timerProvider.fireAll();

      const pollDeadline = Date.now() + 5000;
      let finalState = (await ctx.gameService.getGameState(gameId))!;
      while (finalState.status !== "COMPLETED" && Date.now() < pollDeadline) {
        await new Promise((r) => setTimeout(r, 25));
        finalState = (await ctx.gameService.getGameState(gameId))!;
      }

      expect(finalState.status).toBe("COMPLETED");
      expect(finalState.currentPlayerIndex).toBe(-1);

      // E3: timer unregistered on completion — no pending timer for this game.
      expect(ctx.turnTimerService.hasTimer(gameId)).toBe(false);
      expect(ctx.turnTimerService.getDeadline(gameId)).toBeNull();

      // Abandoned state cleared on completion.
      for (const idx of [0, 1, 2]) {
        expect(ctx.connectionManager.isAbandoned(gameId, users[idx]!.id)).toBe(
          false,
        );
      }
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });
});
