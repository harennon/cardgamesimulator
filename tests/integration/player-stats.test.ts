import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { io as ioClient } from "socket.io-client";
import type { Card, PlayerView } from "../../src/shared/engine-types.js";
import type { Big2PublicState } from "../../src/shared/big2-types.js";
import type { GetStatsResponse } from "../../src/shared/model.js";
import {
  createTestServer,
  type TestServerContext,
} from "./helpers/testServer.js";
import { createTestUser } from "./helpers/supabaseUser.js";
import { createTestGuest } from "./helpers/guestUser.js";
import {
  createAuthenticatedSocket,
  disconnectSocket,
  type TypedClientSocket,
} from "./helpers/socketClient.js";

// ---------------------------------------------------------------------------
// Card-play helpers (reused from websocket-game.test.ts pattern)
// ---------------------------------------------------------------------------

const RANK_ORDER = [
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
const SUIT_ORDER = ["clubs", "diamonds", "hearts", "spades"] as const;

function cardValue(card: Card): number {
  const rankIdx = RANK_ORDER.indexOf(card.rank as (typeof RANK_ORDER)[number]);
  const suitIdx = SUIT_ORDER.indexOf(card.suit as (typeof SUIT_ORDER)[number]);
  return rankIdx * 4 + suitIdx;
}

function pickCardsToPlay(
  hand: readonly Card[],
  publicState: Big2PublicState,
): readonly Card[] | null {
  const sorted = [...hand].sort((a, b) => cardValue(a) - cardValue(b));

  if (publicState.isFirstPlayOfGame || publicState.isFreePlay) {
    return sorted[0] ? [sorted[0]] : null;
  }

  const lastPlay = publicState.lastPlay;
  if (!lastPlay) {
    return sorted[0] ? [sorted[0]] : null;
  }

  if (lastPlay.handType.kind === "single") {
    const beating = sorted.find(
      (c) =>
        cardValue(c) > cardValue((lastPlay.handType as { card: Card }).card),
    );
    return beating ? [beating] : null;
  }

  return null;
}

/**
 * Play a game to completion with 4 registered users.
 * Returns the player IDs in seat order.
 */
async function playGameToCompletion(
  ctx: TestServerContext,
  userTokens: { id: string; accessToken: string }[],
  gameId: string,
): Promise<void> {
  const playerIds = userTokens.map((u) => u.id);

  // All 4 connect via WebSocket
  const sockets: TypedClientSocket[] = await Promise.all(
    userTokens.map((u) =>
      createAuthenticatedSocket(ctx.baseUrl, u.accessToken),
    ),
  );

  try {
    // Join game room
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

    // Set up initial state listeners
    const statePromises = sockets.map(
      (socket) =>
        new Promise<PlayerView>((resolve) => {
          socket.once("game:state", resolve);
        }),
    );

    // Start the game
    await new Promise<void>((resolve, reject) => {
      sockets[0]!.emit("game:start", { gameId }, (ack) => {
        if (ack.success) resolve();
        else reject(new Error(`game:start failed: ${ack.error}`));
      });
    });

    const initialStates = await Promise.all(statePromises);
    const playerStates = new Map<string, PlayerView>();
    for (let i = 0; i < 4; i++) {
      playerStates.set(playerIds[i]!, initialStates[i]!);
    }

    // Ongoing state listeners
    for (let i = 0; i < 4; i++) {
      const socket = sockets[i]!;
      const userId = playerIds[i]!;
      socket.on("game:state", (state) => {
        playerStates.set(userId, state);
      });
    }

    let turnCount = 0;
    const MAX_TURNS = 400;

    while (turnCount < MAX_TURNS) {
      const anyState = [...playerStates.values()][0]!;
      if (anyState.status === "COMPLETED") break;

      const currentPlayerIndex = anyState.currentPlayerIndex;
      const currentPlayerId = anyState.players[currentPlayerIndex]?.playerId;
      if (!currentPlayerId) break;

      const currentUserIndex = playerIds.indexOf(currentPlayerId);
      if (currentUserIndex === -1) break;

      const currentState = playerStates.get(currentPlayerId)!;
      const validActions = currentState.validActions;
      if (validActions.length === 0) break;

      const socket = sockets[currentUserIndex]!;
      const publicState =
        currentState.gameSpecificPublicState as Big2PublicState;

      const hasPass = validActions.some((a) => a.type === "pass");
      const hasPlayCards = validActions.some((a) => a.type === "playCards");

      const nextStatePromises = sockets.map(
        (s, idx) =>
          new Promise<{ userId: string; state: PlayerView }>((resolve) => {
            s.once("game:state", (state) => {
              resolve({ userId: playerIds[idx]!, state });
            });
          }),
      );

      let action: Record<string, unknown>;

      if (
        hasPass &&
        !publicState.isFreePlay &&
        !publicState.isFirstPlayOfGame
      ) {
        action = { type: "pass", playerId: currentPlayerId };
      } else if (hasPlayCards) {
        const cards = pickCardsToPlay(currentState.you.hand, publicState);
        if (!cards) {
          action = { type: "pass", playerId: currentPlayerId };
        } else {
          action = { type: "playCards", playerId: currentPlayerId, cards };
        }
      } else {
        action = { type: "pass", playerId: currentPlayerId };
      }

      await new Promise<void>((resolve, reject) => {
        socket.emit("game:action", { gameId, action }, (ack) => {
          if (ack.success) resolve();
          else reject(new Error(`game:action failed: ${ack.error}`));
        });
      });

      const nextStates = await Promise.all(nextStatePromises);
      for (const { userId, state } of nextStates) {
        playerStates.set(userId, state);
      }

      turnCount++;
    }

    const finalState = [...playerStates.values()][0]!;
    if (finalState.status !== "COMPLETED") {
      throw new Error(
        `Game did not complete within ${MAX_TURNS} turns (status: ${finalState.status})`,
      );
    }

    // Give fire-and-forget stats recording time to settle
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    sockets.forEach(disconnectSocket);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Player stats integration", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("GET /stats returns zeroed stats for a new user with no games", async () => {
    const user = await createTestUser("StatsNewUser");

    const res = await request(ctx.app)
      .get("/stats")
      .set("Authorization", `Bearer ${user.accessToken}`);

    expect(res.status).toBe(200);
    const body = res.body as GetStatsResponse;
    expect(body.userId).toBe(user.id);
    expect(body.gamesPlayed).toBe(0);
    expect(body.gamesWon).toBe(0);
    expect(body.gamesLost).toBe(0);
    expect(body.totalScore).toBe(0);
    expect(body.winRate).toBe(0);
    expect(body.lastPlayedAt).toBeNull();
  });

  it("GET /stats returns 401 without an auth token", async () => {
    const res = await request(ctx.app).get("/stats");
    expect(res.status).toBe(401);
  });

  it("GET /stats returns zeroed stats for a guest (no DB row created)", async () => {
    // Need a game to create a guest session
    const host = await createTestUser("StatsGuestHost");
    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });
    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    const guest = await createTestGuest(ctx.app, gameId, "GuestStatsPlayer");

    const res = await request(ctx.app)
      .get("/stats")
      .set("Authorization", `Bearer ${guest.token}`);

    expect(res.status).toBe(200);
    const body = res.body as GetStatsResponse;
    expect(body.userId).toBe(guest.guestId);
    expect(body.gamesPlayed).toBe(0);
    expect(body.gamesWon).toBe(0);
    expect(body.winRate).toBe(0);
    expect(body.lastPlayedAt).toBeNull();
  });

  it("stats show gamesPlayed: 1 after a completed game", async () => {
    const users = await Promise.all([
      createTestUser("StatsPlay1"),
      createTestUser("StatsPlay2"),
      createTestUser("StatsPlay3"),
      createTestUser("StatsPlay4"),
    ]);

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${users[0]!.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });
    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    for (let i = 1; i < 4; i++) {
      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${users[i]!.accessToken}`)
        .send({ gameId });
    }

    await playGameToCompletion(ctx, users, gameId);

    // Every player should have gamesPlayed = 1
    for (const user of users) {
      const res = await request(ctx.app)
        .get("/stats")
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      const body = res.body as GetStatsResponse;
      expect(body.gamesPlayed).toBe(1);
      expect(body.lastPlayedAt).not.toBeNull();
    }
  });

  it("winner's stats show gamesWon: 1, loser's stats show gamesLost: 1", async () => {
    const users = await Promise.all([
      createTestUser("StatsWin1"),
      createTestUser("StatsWin2"),
      createTestUser("StatsWin3"),
      createTestUser("StatsWin4"),
    ]);

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${users[0]!.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });
    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    for (let i = 1; i < 4; i++) {
      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${users[i]!.accessToken}`)
        .send({ gameId });
    }

    await playGameToCompletion(ctx, users, gameId);

    let totalWins = 0;
    let totalLosses = 0;

    for (const user of users) {
      const res = await request(ctx.app)
        .get("/stats")
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      const body = res.body as GetStatsResponse;
      totalWins += body.gamesWon;
      totalLosses += body.gamesLost;
      // Each player has exactly 1 win or 1 loss
      expect(body.gamesWon + body.gamesLost).toBe(1);
    }

    // Exactly 1 winner and 3 losers across all players
    expect(totalWins).toBe(1);
    expect(totalLosses).toBe(3);
  });

  it("guest player has no stats row after game completion", async () => {
    const users = await Promise.all([
      createTestUser("StatsGuestGame1"),
      createTestUser("StatsGuestGame2"),
      createTestUser("StatsGuestGame3"),
    ]);

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${users[0]!.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });
    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    for (let i = 1; i < 3; i++) {
      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${users[i]!.accessToken}`)
        .send({ gameId });
    }

    // Add a guest as the 4th player
    const guest = await createTestGuest(
      ctx.app,
      gameId,
      "GuestStatsGamePlayer",
    );
    await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${guest.token}`)
      .send({ gameId });

    // Play with 3 registered users + 1 guest (guest has a valid socket token)
    const allPlayers = [
      ...users.map((u) => ({ id: u.id, accessToken: u.accessToken })),
      { id: guest.guestId, accessToken: guest.token },
    ];

    const playerIds = allPlayers.map((u) => u.id);
    const sockets: TypedClientSocket[] = await Promise.all(
      allPlayers.map((u) =>
        createAuthenticatedSocket(ctx.baseUrl, u.accessToken),
      ),
    );

    try {
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

      const statePromises = sockets.map(
        (socket) =>
          new Promise<PlayerView>((resolve) => {
            socket.once("game:state", resolve);
          }),
      );

      await new Promise<void>((resolve, reject) => {
        sockets[0]!.emit("game:start", { gameId }, (ack) => {
          if (ack.success) resolve();
          else reject(new Error(`game:start failed: ${ack.error}`));
        });
      });

      const initialStates = await Promise.all(statePromises);
      const playerStates = new Map<string, PlayerView>();
      for (let i = 0; i < 4; i++) {
        playerStates.set(playerIds[i]!, initialStates[i]!);
      }

      for (let i = 0; i < 4; i++) {
        const socket = sockets[i]!;
        const userId = playerIds[i]!;
        socket.on("game:state", (state) => {
          playerStates.set(userId, state);
        });
      }

      let turnCount = 0;
      const MAX_TURNS = 400;

      while (turnCount < MAX_TURNS) {
        const anyState = [...playerStates.values()][0]!;
        if (anyState.status === "COMPLETED") break;

        const currentPlayerIndex = anyState.currentPlayerIndex;
        const currentPlayerId = anyState.players[currentPlayerIndex]?.playerId;
        if (!currentPlayerId) break;

        const currentUserIndex = playerIds.indexOf(currentPlayerId);
        if (currentUserIndex === -1) break;

        const currentState = playerStates.get(currentPlayerId)!;
        const validActions = currentState.validActions;
        if (validActions.length === 0) break;

        const socket = sockets[currentUserIndex]!;
        const publicState =
          currentState.gameSpecificPublicState as Big2PublicState;

        const hasPass = validActions.some((a) => a.type === "pass");
        const hasPlayCards = validActions.some((a) => a.type === "playCards");

        const nextStatePromises = sockets.map(
          (s, idx) =>
            new Promise<{ userId: string; state: PlayerView }>((resolve) => {
              s.once("game:state", (state) => {
                resolve({ userId: playerIds[idx]!, state });
              });
            }),
        );

        let action: Record<string, unknown>;
        if (
          hasPass &&
          !publicState.isFreePlay &&
          !publicState.isFirstPlayOfGame
        ) {
          action = { type: "pass", playerId: currentPlayerId };
        } else if (hasPlayCards) {
          const cards = pickCardsToPlay(currentState.you.hand, publicState);
          action = cards
            ? { type: "playCards", playerId: currentPlayerId, cards }
            : { type: "pass", playerId: currentPlayerId };
        } else {
          action = { type: "pass", playerId: currentPlayerId };
        }

        await new Promise<void>((resolve, reject) => {
          socket.emit("game:action", { gameId, action }, (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`game:action failed: ${ack.error}`));
          });
        });

        const nextStates = await Promise.all(nextStatePromises);
        for (const { userId, state } of nextStates) {
          playerStates.set(userId, state);
        }

        turnCount++;
      }

      // Give fire-and-forget stats recording time to settle
      await new Promise((r) => setTimeout(r, 100));

      // Guest's GET /stats should return zeroed stats
      const guestStatsRes = await request(ctx.app)
        .get("/stats")
        .set("Authorization", `Bearer ${guest.token}`);
      expect(guestStatsRes.status).toBe(200);
      const guestBody = guestStatsRes.body as GetStatsResponse;
      expect(guestBody.gamesPlayed).toBe(0);
      expect(guestBody.lastPlayedAt).toBeNull();
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("winRate is correctly computed after multiple games", async () => {
    // Play 2 games with the same user to get multiple data points.
    // We can't control who wins, so we just verify the formula is correct
    // (winRate = gamesWon / gamesPlayed) for whatever outcomes occur.
    const targetUser = await createTestUser("StatsWinRateTarget");
    const others = await Promise.all([
      createTestUser("StatsWinRateOther1"),
      createTestUser("StatsWinRateOther2"),
      createTestUser("StatsWinRateOther3"),
    ]);
    const allUsers = [targetUser, ...others];

    for (let g = 0; g < 2; g++) {
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${targetUser.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });
      expect(createRes.status).toBe(200);
      const gameId = createRes.body.gameId as string;

      for (let i = 1; i < 4; i++) {
        await request(ctx.app)
          .post("/joinGame")
          .set("Authorization", `Bearer ${allUsers[i]!.accessToken}`)
          .send({ gameId });
      }

      await playGameToCompletion(ctx, allUsers, gameId);
    }

    const res = await request(ctx.app)
      .get("/stats")
      .set("Authorization", `Bearer ${targetUser.accessToken}`);
    expect(res.status).toBe(200);
    const body = res.body as GetStatsResponse;

    expect(body.gamesPlayed).toBe(2);
    expect(body.gamesWon + body.gamesLost).toBe(2);

    // winRate must equal gamesWon / gamesPlayed rounded to 3 decimal places
    const expectedWinRate =
      body.gamesPlayed > 0
        ? Math.round((body.gamesWon / body.gamesPlayed) * 1000) / 1000
        : 0;
    expect(body.winRate).toBe(expectedWinRate);
  });

  it("incrementStats is atomic — concurrent upserts both succeed and values are summed", async () => {
    // Direct repository-level test using PostgresDB.INSTANCE (already initialized by testServer)
    const { PostgresDB } =
      await import("../../src/backend/database/postgres.js");
    const db = PostgresDB.INSTANCE;
    const testUserId = `ffffffff-0000-0000-0000-${Date.now().toString(16).padStart(12, "0")}`;

    const delta1 = {
      gamesPlayed: 1,
      gamesWon: 1,
      gamesLost: 0,
      totalScore: 10,
    };
    const delta2 = { gamesPlayed: 1, gamesWon: 0, gamesLost: 1, totalScore: 5 };

    // Fire two concurrent upserts
    await Promise.all([
      db.incrementStats(testUserId, delta1),
      db.incrementStats(testUserId, delta2),
    ]);

    const stats = await db.getStats(testUserId);
    expect(stats).not.toBeNull();
    expect(stats!.gamesPlayed).toBe(2);
    expect(stats!.gamesWon).toBe(1);
    expect(stats!.gamesLost).toBe(1);
    expect(stats!.totalScore).toBe(15);
  });
});
