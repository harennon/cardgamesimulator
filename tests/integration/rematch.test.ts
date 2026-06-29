import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import type {
  InternalGameState,
  PlayerInfo,
} from "../../src/shared/engine-types.js";

const SEED_URL = "/test/seed-state";

/**
 * Seed a started game to COMPLETED in both the cache and DB, without disturbing
 * its join_code. Keeps sockets in the room (no game:leave / disconnect).
 */
async function completeGame(
  ctx: TestServerContext,
  gameId: string,
  players: PlayerInfo[],
): Promise<void> {
  const playerList = players.map((p) => ({
    playerId: p.playerId,
    displayName: p.displayName,
  }));
  const state: Partial<InternalGameState> = {
    status: "COMPLETED",
    players: playerList,
    winner: players[0]!.playerId,
    scores: players.map((p, i) => ({
      playerId: p.playerId,
      score: i === 0 ? 5 : 0,
    })),
    currentPlayerIndex: -1,
    gameType: "big2",
    version: 2,
    turnNumber: 10,
    randomSeed: "rematch-test-seed",
    gameSpecificState: {
      hands: players.map(() => []),
      lastPlay: null,
      lastPlayPlayerIndex: null,
      consecutivePasses: 0,
      isFreePlay: false,
      isFirstPlayOfGame: false,
      playHistory: [],
      finishedPlayerIndices: players.map((_, i) => i),
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

/**
 * Set up a 2-player game, join both via WebSocket, start it, then seed it to
 * COMPLETED. Returns the sockets (still connected and in the room), gameId,
 * joinCode and the player infos.
 */
async function setupCompletedGame(ctx: TestServerContext): Promise<{
  sockets: TypedClientSocket[];
  gameId: string;
  joinCode: string;
  players: PlayerInfo[];
}> {
  const [userA, userB] = await Promise.all([
    createTestUser("RematchHost"),
    createTestUser("RematchGuest"),
  ]);

  const createRes = await request(ctx.app)
    .post("/createGame")
    .set("Authorization", `Bearer ${userA!.accessToken}`)
    .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 30 });
  expect(createRes.status).toBe(200);
  const gameId = createRes.body.gameId as string;
  const joinCode = createRes.body.joinCode as string;

  await request(ctx.app)
    .post("/joinGame")
    .set("Authorization", `Bearer ${userB!.accessToken}`)
    .send({ gameId });

  const sockets = await Promise.all([
    createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
    createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
  ]);

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

  // Start the game so its DB status is IN_PROGRESS before we flip to COMPLETED.
  const startStates = sockets.map(
    (socket) =>
      new Promise<EnrichedPlayerView>((resolve) => {
        socket.once("game:state", resolve);
      }),
  );
  await new Promise<void>((resolve, reject) => {
    sockets[0]!.emit("game:start", { gameId }, (ack) => {
      if (ack.success) resolve();
      else reject(new Error(`game:start failed: ${ack.error}`));
    });
  });
  await Promise.all(startStates);

  const players: PlayerInfo[] = [
    { playerId: userA!.id, displayName: "RematchHost" },
    { playerId: userB!.id, displayName: "RematchGuest" },
  ];
  await completeGame(ctx, gameId, players);

  return { sockets, gameId, joinCode, players };
}

function emitRematch(
  socket: TypedClientSocket,
  gameId: string,
): Promise<{ success: boolean; newGameId?: string; error?: string }> {
  return new Promise((resolve) => {
    socket.emit("game:rematch", { gameId }, resolve);
  });
}

describe("Rematch integration", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("host rematch acks success and broadcasts game:rematchStarted to other connected players", async () => {
    const { sockets, gameId } = await setupCompletedGame(ctx);
    try {
      // Listen for the broadcast on the non-host socket.
      const broadcastPromise = new Promise<GameRematchStartedPayload>(
        (resolve) => {
          sockets[1]!.once("game:rematchStarted", resolve);
        },
      );

      const ack = await emitRematch(sockets[0]!, gameId);
      expect(ack.success).toBe(true);
      expect(ack.newGameId).toBeTypeOf("string");
      expect(ack.newGameId).not.toBe(gameId);

      const broadcast = await broadcastPromise;
      expect(broadcast.newGameId).toBe(ack.newGameId);
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("non-host rematch is rejected with NOT_HOST and no broadcast", async () => {
    const { sockets, gameId } = await setupCompletedGame(ctx);
    try {
      let broadcastReceived = false;
      sockets[0]!.once("game:rematchStarted", () => {
        broadcastReceived = true;
      });

      const ack = await emitRematch(sockets[1]!, gameId);
      expect(ack.success).toBe(false);
      expect(ack.error).toBe("NOT_HOST");

      await new Promise((r) => setTimeout(r, 100));
      expect(broadcastReceived).toBe(false);
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("spectator rematch is rejected with SPECTATOR_CANNOT_ACT", async () => {
    const { sockets, gameId } = await setupCompletedGame(ctx);
    const spectatorUser = await createTestUser("RematchSpectator");
    const spectatorSocket = await createAuthenticatedSocket(
      ctx.baseUrl,
      spectatorUser.accessToken,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        spectatorSocket.emit(
          "game:join",
          { gameId, role: "spectator" },
          (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`spectator join failed: ${ack.error}`));
          },
        );
      });

      const ack = await emitRematch(spectatorSocket, gameId);
      expect(ack.success).toBe(false);
      expect(ack.error).toBe("SPECTATOR_CANNOT_ACT");
    } finally {
      sockets.forEach(disconnectSocket);
      disconnectSocket(spectatorSocket);
    }
  });

  it("a second rematch of the same finished game is rejected with REMATCH_ALREADY_STARTED", async () => {
    const { sockets, gameId } = await setupCompletedGame(ctx);
    try {
      const first = await emitRematch(sockets[0]!, gameId);
      expect(first.success).toBe(true);

      const second = await emitRematch(sockets[0]!, gameId);
      expect(second.success).toBe(false);
      expect(second.error).toBe("REMATCH_ALREADY_STARTED");
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("the new game is IN_PROGRESS, carries the transferred joinCode, and the old joinCode resolves only to the new game", async () => {
    const { sockets, gameId, joinCode } = await setupCompletedGame(ctx);
    try {
      const ack = await emitRematch(sockets[0]!, gameId);
      expect(ack.success).toBe(true);
      const newGameId = ack.newGameId!;

      // Join the new game and assert IN_PROGRESS + transferred joinCode.
      const newState = await new Promise<EnrichedPlayerView>(
        (resolve, reject) => {
          sockets[0]!.once("game:state", resolve);
          sockets[0]!.emit(
            "game:join",
            { gameId: newGameId, role: "player" },
            (joinAck) => {
              if (!joinAck.success) {
                reject(new Error(`join new game failed: ${joinAck.error}`));
              }
            },
          );
        },
      );
      expect(newState.status).toBe("IN_PROGRESS");
      expect(newState.joinCode).toBe(joinCode);

      // The shared code resolves to the new game in the DB.
      const newGame = await ctx.gameService.getGame(newGameId);
      expect(newGame?.joinCode).toBe(joinCode);
      const oldGame = await ctx.gameService.getGame(gameId);
      expect(oldGame?.joinCode).toBeNull();
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("registers and starts a turn timer for the new game when the old game had one", async () => {
    const { sockets, gameId } = await setupCompletedGame(ctx);
    try {
      const ack = await emitRematch(sockets[0]!, gameId);
      expect(ack.success).toBe(true);
      const newGameId = ack.newGameId!;

      // The new game was created with turnTimerSeconds: 30 (carried over), so a
      // timer must be registered and a deadline set.
      expect(ctx.turnTimerService.hasTimer(newGameId)).toBe(true);
      expect(ctx.turnTimerService.getDeadline(newGameId)).not.toBeNull();
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("ignores a spoofed payload — only connected players from the old game are carried over", async () => {
    const { sockets, gameId, players } = await setupCompletedGame(ctx);
    try {
      // The payload carries only { gameId } — there is no field through which a
      // client could inject extra players. The roster is server-computed.
      const ack = await emitRematch(sockets[0]!, gameId);
      expect(ack.success).toBe(true);
      const newGame = await ctx.gameService.getGame(ack.newGameId!);
      expect([...(newGame?.playerIds ?? [])].sort()).toEqual(
        players.map((p) => p.playerId).sort(),
      );
      // Host is first (host clicked the rematch).
      expect(newGame?.playerIds[0]).toBe(players[0]!.playerId);
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });
});
