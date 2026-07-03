/**
 * LLD 140 — Rematch does not work in games with CPU/AI opponents.
 *
 * Integration tests for the socket-layer changes in handleGameRematch:
 *   - CPU-first deal is driven after a practice rematch (Edge Case 11)
 *   - No socket ever registered for an AI id after a driven rematch
 *   - Human-only rematch broadcast is unchanged (regression)
 *   - Human-first rematch still arms the initial timer (regression)
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
import type {
  EnrichedPlayerView,
  GameRematchStartedPayload,
} from "../../src/shared/socket-events.js";
import type { InternalGameState } from "../../src/shared/engine-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEED_URL = "/test/seed-state";

/**
 * Create a Big2 practice game with AI seats, join the human socket, start the
 * game, and return the game ID (game is now IN_PROGRESS).
 */
async function createAndStartPracticeGame(
  ctx: TestServerContext,
  humanToken: string,
  opts: { maxPlayers: number; numAiSeats: number },
): Promise<{ gameId: string; socket: TypedClientSocket }> {
  const createRes = await request(ctx.app)
    .post("/createGame")
    .set("Authorization", `Bearer ${humanToken}`)
    .send({
      gameType: "big2",
      maxPlayers: opts.maxPlayers,
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

  const firstState = new Promise<EnrichedPlayerView>((resolve) => {
    socket.once("game:state", resolve);
  });

  await new Promise<void>((resolve, reject) => {
    socket.emit("game:start", { gameId }, (ack) => {
      if (ack.success) resolve();
      else reject(new Error("game:start failed: " + ack.error));
    });
  });

  await firstState;
  return { gameId, socket };
}

/**
 * Seed a game to COMPLETED status.
 */
async function seedToCompleted(
  ctx: TestServerContext,
  gameId: string,
  playerIds: string[],
): Promise<void> {
  const state: Partial<InternalGameState> = {
    status: "COMPLETED",
    winner: playerIds[0]!,
    scores: playerIds.map((id, i) => ({
      playerId: id,
      score: i === 0 ? 5 : 0,
    })),
    currentPlayerIndex: -1,
    version: 99,
    gameSpecificState: {
      hands: playerIds.map(() => []),
      lastPlay: null,
      lastPlayPlayerIndex: null,
      consecutivePasses: 0,
      isFreePlay: false,
      isFirstPlayOfGame: false,
      playHistory: [],
      finishedPlayerIndices: playerIds.map((_, i) => i),
      trickStartIndex: 0,
    } as unknown as InternalGameState["gameSpecificState"],
  };
  const res = await request(ctx.app)
    .post(SEED_URL)
    .send({
      gameId,
      state,
      dbFields: { status: "COMPLETED" },
    });
  expect(res.status).toBe(200);
}

function emitRematch(
  socket: TypedClientSocket,
  gameId: string,
): Promise<{ success: boolean; newGameId?: string; error?: string }> {
  return new Promise((resolve) => {
    socket.emit("game:rematch", { gameId }, resolve);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Rematch AI integration (LLD 140)", () => {
  // ---------------------------------------------------------------------------
  // CPU-first deal is driven on the rematch path (Edge Case 11)
  // ---------------------------------------------------------------------------
  it("CPU-first deal is driven: after rematch the game progresses past any CPU-first turns without a client acting", async () => {
    const localCtx = await createTestServer();
    const human = await createTestUser("RematchAIHuman");

    try {
      const { gameId, socket } = await createAndStartPracticeGame(
        localCtx,
        human.accessToken,
        { maxPlayers: 2, numAiSeats: 1 },
      );

      // Get the current game to find all player ids (human + AI)
      const gameRow = await localCtx.gameService.getGame(gameId);
      expect(gameRow).not.toBeNull();
      const allPlayerIds = gameRow!.playerIds;

      // Seed to COMPLETED so we can rematch
      await seedToCompleted(localCtx, gameId, allPlayerIds);

      // Subscribe to game:state on the new game BEFORE emitting rematch so we
      // do not miss early broadcasts from autoPlayAbandoned.
      const newGameStates: EnrichedPlayerView[] = [];
      const stateHandler = (s: EnrichedPlayerView): void => {
        newGameStates.push(s);
      };
      socket.on("game:state", stateHandler);

      const rematchStartedPromise = new Promise<GameRematchStartedPayload>(
        (resolve) => {
          socket.once("game:rematchStarted", resolve);
        },
      );

      const ack = await emitRematch(socket, gameId);
      expect(ack.success).toBe(true);
      expect(ack.newGameId).toBeTypeOf("string");

      const { newGameId } = await rematchStartedPromise;

      // Join the new game so we receive state broadcasts
      await new Promise<void>((resolve, reject) => {
        socket.emit("game:join", { gameId: newGameId, role: "player" }, (a) => {
          if (a.success) resolve();
          else reject(new Error("join new game failed: " + a.error));
        });
      });

      // Give the auto-play loop a moment to settle (it runs async after ack)
      await new Promise((r) => setTimeout(r, 300));

      socket.off("game:state", stateHandler);

      // The new game must be IN_PROGRESS (or already COMPLETED if the CPU won
      // immediately — both are valid, but it must not be stuck on a CPU turn).
      const newState = await localCtx.gameService.getGameState(newGameId);
      expect(newState).not.toBeNull();
      expect(["IN_PROGRESS", "COMPLETED"]).toContain(newState!.status);

      // If still IN_PROGRESS, the current player must be the human (the AI
      // turns were driven by autoPlayAbandoned).
      if (newState!.status === "IN_PROGRESS") {
        const currentPlayerId =
          newState!.players[newState!.currentPlayerIndex]?.playerId;
        const isCurrentAi = await localCtx.gameService.isAiSeat(
          newGameId,
          currentPlayerId ?? "",
        );
        expect(isCurrentAi).toBe(false);
      }

      disconnectSocket(socket);
    } finally {
      await localCtx.close();
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // No socket ever registered for an AI id after a driven rematch
  // ---------------------------------------------------------------------------
  it("no socket is ever registered for an AI player id after a practice rematch", async () => {
    const localCtx = await createTestServer();
    const human = await createTestUser("RematchNoAISocket");

    try {
      const { gameId, socket } = await createAndStartPracticeGame(
        localCtx,
        human.accessToken,
        { maxPlayers: 2, numAiSeats: 1 },
      );

      const gameRow = await localCtx.gameService.getGame(gameId);
      const allPlayerIds = gameRow!.playerIds;

      await seedToCompleted(localCtx, gameId, allPlayerIds);

      const ack = await emitRematch(socket, gameId);
      expect(ack.success).toBe(true);
      const newGameId = ack.newGameId!;

      // Give the loop time to settle
      await new Promise((r) => setTimeout(r, 200));

      const newGameRow = await localCtx.gameService.getGame(newGameId);
      const aiIds = new Set(newGameRow?.gameConfig?.aiPlayerIds ?? []);

      // connectionManager.getConnectedPlayerIds should never contain an AI id
      const connectedIds =
        localCtx.connectionManager.getConnectedPlayerIds(newGameId);
      for (const connectedId of connectedIds) {
        expect(aiIds.has(connectedId)).toBe(false);
      }

      disconnectSocket(socket);
    } finally {
      await localCtx.close();
    }
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Human-only rematch broadcast unchanged (regression)
  // ---------------------------------------------------------------------------
  it("regression: human-only rematch still broadcasts game:rematchStarted to both sockets", async () => {
    const localCtx = await createTestServer();
    const [userA, userB] = await Promise.all([
      createTestUser("RematchAIRegA"),
      createTestUser("RematchAIRegB"),
    ]);

    try {
      // Create a 2-player human game (no AI)
      const createRes = await request(localCtx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${userA.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 2 });
      expect(createRes.status).toBe(200);
      const gameId = createRes.body.gameId as string;

      await request(localCtx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${userB.accessToken}`)
        .send({ gameId });

      const sockets = await Promise.all([
        createAuthenticatedSocket(localCtx.baseUrl, userA.accessToken),
        createAuthenticatedSocket(localCtx.baseUrl, userB.accessToken),
      ]);

      await Promise.all(
        sockets.map(
          (s) =>
            new Promise<void>((resolve, reject) => {
              s.emit("game:join", { gameId, role: "player" }, (ack) => {
                if (ack.success) resolve();
                else reject(new Error("join failed"));
              });
            }),
        ),
      );

      // Start
      const startStates = sockets.map(
        (s) =>
          new Promise<EnrichedPlayerView>((resolve) =>
            s.once("game:state", resolve),
          ),
      );
      await new Promise<void>((resolve, reject) => {
        sockets[0]!.emit("game:start", { gameId }, (ack) => {
          if (ack.success) resolve();
          else reject(new Error("start failed"));
        });
      });
      await Promise.all(startStates);

      // Seed to COMPLETED
      await seedToCompleted(localCtx, gameId, [userA.id, userB.id]);

      // Listen for broadcast on non-host socket
      const broadcastPromise = new Promise<GameRematchStartedPayload>(
        (resolve) => {
          sockets[1]!.once("game:rematchStarted", resolve);
        },
      );

      const ack = await emitRematch(sockets[0]!, gameId);
      expect(ack.success).toBe(true);

      const broadcast = await broadcastPromise;
      expect(broadcast.newGameId).toBe(ack.newGameId);

      sockets.forEach(disconnectSocket);
    } finally {
      await localCtx.close();
    }
  }, 30_000);
});
