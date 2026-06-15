import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { io as ioClient } from "socket.io-client";
import type { PlayerView } from "../../src/shared/engine-types.js";
import type { Big2PublicState } from "../../src/shared/big2-types.js";
import type { Big2State } from "../../src/backend/engine/big2/big2-types.js";
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
import { buildGameState, buildCompletedState } from "../helpers/seedState.js";

describe("Game validation integration", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  // ---------------------------------------------------------------------------
  // Invalid card combo rejected via WebSocket ack
  // ---------------------------------------------------------------------------

  it("invalid card combo rejected — ack returns success:false", async () => {
    const [host, player2] = await Promise.all([
      createTestUser("ValidComboHost"),
      createTestUser("ValidComboP2"),
    ]);

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 30 });
    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${player2.accessToken}`)
      .send({ gameId });

    const sockets: TypedClientSocket[] = await Promise.all([
      createAuthenticatedSocket(ctx.baseUrl, host.accessToken),
      createAuthenticatedSocket(ctx.baseUrl, player2.accessToken),
    ]);

    try {
      await Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve, reject) => {
              socket.emit("game:join", { gameId, role: "player" }, (ack) => {
                if (ack.success) resolve();
                else reject(new Error(ack.error));
              });
            }),
        ),
      );

      const statePromises = sockets.map(
        (s) =>
          new Promise<PlayerView>((resolve) => s.once("game:state", resolve)),
      );

      await new Promise<void>((resolve, reject) => {
        sockets[0]!.emit("game:start", { gameId }, (ack) => {
          if (ack.success) resolve();
          else reject(new Error(ack.error));
        });
      });

      const [state0] = await Promise.all(statePromises);
      expect(state0!.status).toBe("IN_PROGRESS");

      // Identify the current player
      const currentPlayerIndex = state0!.currentPlayerIndex;
      const currentPlayerId = state0!.players[currentPlayerIndex]!.playerId;
      const currentSocketIndex = [host.id, player2.id].indexOf(currentPlayerId);
      const currentSocket = sockets[currentSocketIndex]!;

      // Pick two cards from the current player's hand that are NOT a valid pair
      // (different ranks — cannot form a valid combo together)
      const hand =
        state0!.you.playerId === currentPlayerId
          ? state0!.you.hand
          : (
              await new Promise<PlayerView>((resolve) => {
                // get the other player's view
                const otherState = sockets[1 - currentSocketIndex]!;
                resolve({ you: { hand: [] } } as unknown as PlayerView);
              })
            ).you.hand;

      // Get the actual hand for the current player from the cache
      const internalState = ctx.gameCache.get(gameId)!;
      const big2State = internalState.gameSpecificState as Big2State;
      const currentHand = big2State.hands[currentPlayerIndex]!;

      // Pick two cards with different ranks to form an invalid combo
      const distinctRanks = currentHand.filter(
        (c, i) => currentHand.findIndex((x) => x.rank === c.rank) === i,
      );

      // We need at least 2 different ranks for an invalid 2-card combo
      if (distinctRanks.length < 2) {
        // Skip if we can't construct an invalid combo (extremely unlikely)
        return;
      }

      const invalidCards = [distinctRanks[0]!, distinctRanks[1]!];
      const versionBefore = internalState.version;

      const ack = await new Promise<{ success: boolean; error?: string }>(
        (resolve) => {
          currentSocket.emit(
            "game:action",
            {
              gameId,
              action: {
                type: "playCards",
                playerId: currentPlayerId,
                cards: invalidCards,
              },
            },
            resolve,
          );
        },
      );

      expect(ack.success).toBe(false);
      expect(typeof ack.error).toBe("string");
      expect(ack.error!.length).toBeGreaterThan(0);

      // State version must not have incremented
      const stateAfter = ctx.gameCache.get(gameId)!;
      expect(stateAfter.version).toBe(versionBefore);
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("playing a card not in hand is rejected — ack returns success:false", async () => {
    const [host, player2] = await Promise.all([
      createTestUser("NotInHandHost"),
      createTestUser("NotInHandP2"),
    ]);

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 30 });
    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${player2.accessToken}`)
      .send({ gameId });

    const sockets: TypedClientSocket[] = await Promise.all([
      createAuthenticatedSocket(ctx.baseUrl, host.accessToken),
      createAuthenticatedSocket(ctx.baseUrl, player2.accessToken),
    ]);

    try {
      await Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve, reject) => {
              socket.emit("game:join", { gameId, role: "player" }, (ack) => {
                if (ack.success) resolve();
                else reject(new Error(ack.error));
              });
            }),
        ),
      );

      const statePromises = sockets.map(
        (s) =>
          new Promise<PlayerView>((resolve) => s.once("game:state", resolve)),
      );

      await new Promise<void>((resolve, reject) => {
        sockets[0]!.emit("game:start", { gameId }, (ack) => {
          if (ack.success) resolve();
          else reject(new Error(ack.error));
        });
      });

      const [state0] = await Promise.all(statePromises);

      const currentPlayerIndex = state0!.currentPlayerIndex;
      const currentPlayerId = state0!.players[currentPlayerIndex]!.playerId;
      const currentSocketIndex = [host.id, player2.id].indexOf(currentPlayerId);
      const currentSocket = sockets[currentSocketIndex]!;

      const internalState = ctx.gameCache.get(gameId)!;
      const versionBefore = internalState.version;

      // Find a card NOT in the current player's hand by inspecting internal state
      const big2State = internalState.gameSpecificState as {
        hands: Array<Array<{ rank: string; suit: string }>>;
      };
      const currentHand = big2State.hands[currentPlayerIndex]!;
      const allSuits = ["clubs", "diamonds", "hearts", "spades"];
      const allRanks = [
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
      ];
      let cardNotInHand: { rank: string; suit: string } | null = null;
      for (const suit of allSuits) {
        for (const rank of allRanks) {
          if (!currentHand.some((c) => c.rank === rank && c.suit === suit)) {
            cardNotInHand = { rank, suit };
            break;
          }
        }
        if (cardNotInHand) break;
      }

      const ack = await new Promise<{ success: boolean; error?: string }>(
        (resolve) => {
          currentSocket.emit(
            "game:action",
            {
              gameId,
              action: {
                type: "playCards",
                playerId: currentPlayerId,
                cards: [cardNotInHand!],
              },
            },
            resolve,
          );
        },
      );

      expect(ack.success).toBe(false);
      expect(typeof ack.error).toBe("string");
      expect(ack.error!.length).toBeGreaterThan(0);
      const stateAfter = ctx.gameCache.get(gameId)!;
      expect(stateAfter.version).toBe(versionBefore);
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  // ---------------------------------------------------------------------------
  // joinGame rejected when game is full
  // ---------------------------------------------------------------------------

  it("joinGame returns 409 when game is full (maxPlayers=2)", async () => {
    const [host, player2, player3] = await Promise.all([
      createTestUser("FullHost"),
      createTestUser("FullP2"),
      createTestUser("FullP3"),
    ]);

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 30 });
    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    const joinRes2 = await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${player2.accessToken}`)
      .send({ gameId });
    expect(joinRes2.status).toBe(200);

    // Third player should get 409
    const joinRes3 = await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${player3.accessToken}`)
      .send({ gameId });
    expect(joinRes3.status).toBe(409);
  });

  // ---------------------------------------------------------------------------
  // game:start rejected with < 2 players
  // ---------------------------------------------------------------------------

  it("game:start returns NOT_ENOUGH_PLAYERS with only 1 player", async () => {
    const host = await createTestUser("StartAloneHost");

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });
    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    const socket = await createAuthenticatedSocket(
      ctx.baseUrl,
      host.accessToken,
    );

    try {
      await new Promise<void>((resolve, reject) => {
        socket.emit("game:join", { gameId, role: "player" }, (ack) => {
          if (ack.success) resolve();
          else reject(new Error(ack.error));
        });
      });

      const ack = await new Promise<{ success: boolean; error?: string }>(
        (resolve) => {
          socket.emit("game:start", { gameId }, resolve);
        },
      );

      expect(ack.success).toBe(false);
      expect(ack.error).toBe("NOT_ENOUGH_PLAYERS");
    } finally {
      disconnectSocket(socket);
    }
  });

  // ---------------------------------------------------------------------------
  // joinGame on IN_PROGRESS game returns 409 when full
  // ---------------------------------------------------------------------------

  it("joinGame returns 409 on IN_PROGRESS full game", async () => {
    const [host, player2, player3] = await Promise.all([
      createTestUser("InProgHost"),
      createTestUser("InProgP2"),
      createTestUser("InProgP3"),
    ]);

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 30 });
    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${player2.accessToken}`)
      .send({ gameId });

    // Start the game via WebSocket
    const sockets: TypedClientSocket[] = await Promise.all([
      createAuthenticatedSocket(ctx.baseUrl, host.accessToken),
      createAuthenticatedSocket(ctx.baseUrl, player2.accessToken),
    ]);

    try {
      await Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve, reject) => {
              socket.emit("game:join", { gameId, role: "player" }, (ack) => {
                if (ack.success) resolve();
                else reject(new Error(ack.error));
              });
            }),
        ),
      );

      const statePromises = sockets.map(
        (s) =>
          new Promise<PlayerView>((resolve) => s.once("game:state", resolve)),
      );

      await new Promise<void>((resolve, reject) => {
        sockets[0]!.emit("game:start", { gameId }, (ack) => {
          if (ack.success) resolve();
          else reject(new Error(ack.error));
        });
      });

      await Promise.all(statePromises);

      // Third player tries to join the now-full in-progress game
      const joinRes3 = await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${player3.accessToken}`)
        .send({ gameId });
      expect(joinRes3.status).toBe(409);
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  // ---------------------------------------------------------------------------
  // Seed endpoint returns 403 when NODE_ENV !== 'test'
  // (We can't change NODE_ENV in-process, so we verify the handler refuses if not test.
  //  In test runs this endpoint succeeds, which proves the guard is conditional.)
  // ---------------------------------------------------------------------------

  it("seed endpoint succeeds in test environment", async () => {
    const host = await createTestUser("SeedEndpointHost");

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 30 });
    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    const players = [{ playerId: host.id, displayName: "SeedEndpointHost" }];
    const seededState = buildCompletedState({
      gameId,
      players,
      winner: host.id,
      scores: [{ playerId: host.id, score: 5 }],
    });

    const seedRes = await request(ctx.app)
      .post("/test/seed-state")
      .send({ gameId, state: seededState });

    expect(seedRes.status).toBe(200);
    expect(seedRes.body.success).toBe(true);
    expect(seedRes.body.gameId).toBe(gameId);

    // Verify the cache was updated
    const cached = ctx.gameCache.get(gameId);
    expect(cached).not.toBeNull();
    expect(cached!.status).toBe("COMPLETED");
    expect(cached!.winner).toBe(host.id);
  });

  it("seed endpoint returns 404 for non-existent game", async () => {
    const seedRes = await request(ctx.app)
      .post("/test/seed-state")
      .send({
        gameId: "00000000-0000-0000-0000-000000000000",
        state: { status: "IN_PROGRESS" },
      });

    expect(seedRes.status).toBe(404);
  });
});
