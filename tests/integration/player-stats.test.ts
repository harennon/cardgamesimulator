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
import { makePgClient, readMigrationSql } from "./helpers/pgClient.js";
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

/**
 * Builds a unique UUID-shaped user id for self-contained repo-level tests.
 * The `tag` (<=4 hex chars) plus a timestamp keep each test's rows isolated
 * so tests don't collide across runs or with each other.
 */
function makeTestUserId(tag: string): string {
  const ts = Date.now().toString(16).padStart(12, "0").slice(-12);
  return `eeeeeeee-0000-0000-${tag.padStart(4, "0")}-${ts}`;
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

  // A1: New user → { userId, games: [] }.
  it("GET /stats returns an empty games array for a new user with no games", async () => {
    const user = await createTestUser("StatsNewUser");

    const res = await request(ctx.app)
      .get("/stats")
      .set("Authorization", `Bearer ${user.accessToken}`);

    expect(res.status).toBe(200);
    const body = res.body as GetStatsResponse;
    expect(body.userId).toBe(user.id);
    expect(body.games).toEqual([]);
  });

  // A5: unauthenticated request rejected.
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
    expect(body.games).toEqual([]);
  });

  // A2: after a Big2 completion, games has one entry { gameType: "big2", gamesPlayed: 1 }.
  it("stats show one big2 entry with gamesPlayed: 1 after a completed game", async () => {
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

    // Every player should have exactly one big2 entry with gamesPlayed = 1
    for (const user of users) {
      const res = await request(ctx.app)
        .get("/stats")
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      const body = res.body as GetStatsResponse;
      expect(body.games).toHaveLength(1);
      const entry = body.games[0]!;
      expect(entry.gameType).toBe("big2");
      expect(entry.gamesPlayed).toBe(1);
      expect(entry.lastPlayedAt).not.toBeNull();
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
      const entry = body.games.find((g) => g.gameType === "big2")!;
      expect(entry).toBeDefined();
      totalWins += entry.gamesWon;
      totalLosses += entry.gamesLost;
      // Each player has exactly 1 win or 1 loss
      expect(entry.gamesWon + entry.gamesLost).toBe(1);
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

      // Guest's GET /stats should return no game entries (no row created)
      const guestStatsRes = await request(ctx.app)
        .get("/stats")
        .set("Authorization", `Bearer ${guest.token}`);
      expect(guestStatsRes.status).toBe(200);
      const guestBody = guestStatsRes.body as GetStatsResponse;
      expect(guestBody.games).toEqual([]);
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

    const entry = body.games.find((g) => g.gameType === "big2")!;
    expect(entry).toBeDefined();
    expect(entry.gamesPlayed).toBe(2);
    expect(entry.gamesWon + entry.gamesLost).toBe(2);

    // winRate must equal gamesWon / gamesPlayed rounded to 3 decimal places
    const expectedWinRate =
      entry.gamesPlayed > 0
        ? Math.round((entry.gamesWon / entry.gamesPlayed) * 1000) / 1000
        : 0;
    expect(entry.winRate).toBe(expectedWinRate);
  });

  // A3: after a Big2 and a Tonk completion, GET /stats returns two entries,
  // each with its own counters that do not bleed across entries. The Tonk
  // completion is recorded directly via the stats path (gameType: "tonk"),
  // so this does NOT depend on the Tonk engine (LLD 65) being implemented.
  it("GET /stats returns separate big2 and tonk entries with non-bleeding counters", async () => {
    const user = await createTestUser("StatsBig2AndTonk");

    const { SupabaseDB } =
      await import("../../src/backend/database/supabaseDb.js");
    const db = SupabaseDB.INSTANCE;

    // Record a big2 result and a tonk result for the same user.
    await db.incrementStats(user.id, "big2", {
      gamesPlayed: 1,
      gamesWon: 1,
      gamesLost: 0,
      totalScore: 5,
    });
    await db.incrementStats(user.id, "tonk", {
      gamesPlayed: 1,
      gamesWon: 0,
      gamesLost: 1,
      totalScore: 40,
    });

    const res = await request(ctx.app)
      .get("/stats")
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(200);
    const body = res.body as GetStatsResponse;

    expect(body.userId).toBe(user.id);
    expect(body.games).toHaveLength(2);

    const big2 = body.games.find((g) => g.gameType === "big2")!;
    const tonk = body.games.find((g) => g.gameType === "tonk")!;
    expect(big2).toBeDefined();
    expect(tonk).toBeDefined();

    expect(big2.gamesPlayed).toBe(1);
    expect(big2.gamesWon).toBe(1);
    expect(big2.gamesLost).toBe(0);
    expect(big2.totalScore).toBe(5);
    expect(big2.winRate).toBe(1);

    expect(tonk.gamesPlayed).toBe(1);
    expect(tonk.gamesWon).toBe(0);
    expect(tonk.gamesLost).toBe(1);
    expect(tonk.totalScore).toBe(40);
    expect(tonk.winRate).toBe(0);
  });

  it("totalScore matches Big2 placement scoring after game completion", async () => {
    const users = await Promise.all([
      createTestUser("TotalScoreP1"),
      createTestUser("TotalScoreP2"),
      createTestUser("TotalScoreP3"),
      createTestUser("TotalScoreP4"),
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

    // Wait for fire-and-forget stats to settle
    await new Promise((r) => setTimeout(r, 100));

    // Fetch stats for all players and verify totalScore sums to 5+3+1+0 = 9
    let totalScoreSum = 0;
    for (const user of users) {
      const res = await request(ctx.app)
        .get("/stats")
        .set("Authorization", `Bearer ${user.accessToken}`);
      expect(res.status).toBe(200);
      const body = res.body as GetStatsResponse;
      const entry = body.games.find((g) => g.gameType === "big2")!;
      expect(entry).toBeDefined();
      // Each player's totalScore must be one of the placement values
      expect([0, 1, 3, 5]).toContain(entry.totalScore);
      totalScoreSum += entry.totalScore;
    }
    // Across all 4 players the scores must sum to 5+3+1+0 = 9
    expect(totalScoreSum).toBe(9);
  });

  // I3: two concurrent incrementStats for the same composite key both succeed;
  // final values are the sum (no lost update).
  it("incrementStats is atomic — concurrent upserts on the same (user, game_type) sum", async () => {
    // Direct repository-level test using SupabaseDB.INSTANCE (already initialized by testServer)
    const { SupabaseDB } =
      await import("../../src/backend/database/supabaseDb.js");
    const db = SupabaseDB.INSTANCE;
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
      db.incrementStats(testUserId, "big2", delta1),
      db.incrementStats(testUserId, "big2", delta2),
    ]);

    const stats = await db.getStats(testUserId, "big2");
    expect(stats).not.toBeNull();
    expect(stats!.gameType).toBe("big2");
    expect(stats!.gamesPlayed).toBe(2);
    expect(stats!.gamesWon).toBe(1);
    expect(stats!.gamesLost).toBe(1);
    expect(stats!.totalScore).toBe(15);
  });

  // I1: per-game isolation — a big2 increment leaves the tonk row untouched.
  it("per-game isolation — a big2 increment does not create or alter a tonk row", async () => {
    const { SupabaseDB } =
      await import("../../src/backend/database/supabaseDb.js");
    const db = SupabaseDB.INSTANCE;
    const userId = makeTestUserId("aaaa");

    await db.incrementStats(userId, "big2", {
      gamesPlayed: 1,
      gamesWon: 1,
      gamesLost: 0,
      totalScore: 7,
    });

    const big2 = await db.getStats(userId, "big2");
    const tonk = await db.getStats(userId, "tonk");

    expect(big2).not.toBeNull();
    expect(big2!.gamesPlayed).toBe(1);
    expect(big2!.gamesWon).toBe(1);
    expect(big2!.totalScore).toBe(7);
    // The tonk row was never touched
    expect(tonk).toBeNull();
  });

  // I2: composite-key upsert — two big2 calls sum into one row; a tonk call
  // creates a SECOND row. getAllStats returns exactly the two expected entries.
  it("composite-key upsert — big2 rows sum, tonk creates a second row", async () => {
    const { SupabaseDB } =
      await import("../../src/backend/database/supabaseDb.js");
    const db = SupabaseDB.INSTANCE;
    const userId = makeTestUserId("bbbb");

    await db.incrementStats(userId, "big2", {
      gamesPlayed: 1,
      gamesWon: 1,
      gamesLost: 0,
      totalScore: 5,
    });
    await db.incrementStats(userId, "big2", {
      gamesPlayed: 1,
      gamesWon: 0,
      gamesLost: 1,
      totalScore: 3,
    });
    await db.incrementStats(userId, "tonk", {
      gamesPlayed: 1,
      gamesWon: 0,
      gamesLost: 1,
      totalScore: 42,
    });

    const all = await db.getAllStats(userId);
    expect(all).toHaveLength(2);

    const big2 = all.find((s) => s.gameType === "big2")!;
    const tonk = all.find((s) => s.gameType === "tonk")!;
    expect(big2).toBeDefined();
    expect(tonk).toBeDefined();

    // big2 summed
    expect(big2.gamesPlayed).toBe(2);
    expect(big2.gamesWon).toBe(1);
    expect(big2.gamesLost).toBe(1);
    expect(big2.totalScore).toBe(8);

    // tonk independent
    expect(tonk.gamesPlayed).toBe(1);
    expect(tonk.gamesWon).toBe(0);
    expect(tonk.gamesLost).toBe(1);
    expect(tonk.totalScore).toBe(42);
  });

  // I5: getAllStats for a user who has played nothing → [].
  it("getAllStats returns [] for a user who has played nothing", async () => {
    const { SupabaseDB } =
      await import("../../src/backend/database/supabaseDb.js");
    const db = SupabaseDB.INSTANCE;
    const userId = makeTestUserId("cccc");

    const all = await db.getAllStats(userId);
    expect(all).toEqual([]);
  });

  // I6: getStats(user, type) returns exactly the matching row or null, never
  // bleeding another game type's counters.
  it("getStats(user, type) returns only the matching game type's row", async () => {
    const { SupabaseDB } =
      await import("../../src/backend/database/supabaseDb.js");
    const db = SupabaseDB.INSTANCE;
    const userId = makeTestUserId("dddd");

    await db.incrementStats(userId, "big2", {
      gamesPlayed: 2,
      gamesWon: 2,
      gamesLost: 0,
      totalScore: 11,
    });
    await db.incrementStats(userId, "tonk", {
      gamesPlayed: 5,
      gamesWon: 0,
      gamesLost: 5,
      totalScore: 99,
    });

    const big2 = await db.getStats(userId, "big2");
    expect(big2).not.toBeNull();
    expect(big2!.gameType).toBe("big2");
    expect(big2!.gamesPlayed).toBe(2);
    expect(big2!.totalScore).toBe(11);

    const tonk = await db.getStats(userId, "tonk");
    expect(tonk).not.toBeNull();
    expect(tonk!.gameType).toBe("tonk");
    expect(tonk!.gamesPlayed).toBe(5);
    expect(tonk!.totalScore).toBe(99);
  });

  // I7: the 6-arg increment_player_stats succeeds, and the old 5-arg overload
  // no longer exists after 005.
  it("RPC signature — 6-arg increment_player_stats works; old 5-arg overload is gone", async () => {
    const { SupabaseDB } =
      await import("../../src/backend/database/supabaseDb.js");
    const db = SupabaseDB.INSTANCE;
    const userId = makeTestUserId("eeee");

    // The 6-arg call (via the repo) succeeds.
    await expect(
      db.incrementStats(userId, "big2", {
        gamesPlayed: 1,
        gamesWon: 1,
        gamesLost: 0,
        totalScore: 1,
      }),
    ).resolves.toBeUndefined();

    // Negative check: confirm exactly one increment_player_stats function exists
    // and it has 6 arguments (the 5-arg overload was dropped by 005).
    const pg = makePgClient();
    await pg.connect();
    try {
      const { rows } = await pg.query<{ nargs: number }>(
        `SELECT pronargs AS nargs FROM pg_proc WHERE proname = 'increment_player_stats';`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.nargs).toBe(6);
    } finally {
      await pg.end();
    }
  });
});

// ---------------------------------------------------------------------------
// I4: Backfill correctness.
//
// A clean `supabase start` already applies 004, so the live DB never exhibits
// the pre-004 single-PK schema this test must exercise. Per LLD 66 §10.1, I4
// self-materializes the pre-004 state in a dedicated throwaway schema, runs the
// REAL 004 SQL against it (search_path-scoped), and asserts the backfill.
// Self-contained: the schema is created and dropped within the test.
// ---------------------------------------------------------------------------

describe("Migration 004 backfill (I4)", () => {
  it("backfills existing pre-004 rows to game_type='big2' and repoints the PK to composite", async () => {
    const schema = `lld66_i4_${Date.now().toString(36)}`;
    const seededUserId = "22222222-2222-2222-2222-222222222222";
    const pg = makePgClient();
    await pg.connect();

    try {
      // 1. Materialize the pre-004 state in an isolated schema:
      //    - games (the 004 guard counts completed non-big2 games)
      //    - player_stats with the OLD single-column PK and no game_type
      //    - one seeded row (as if produced by Big2 before the migration)
      await pg.query(`CREATE SCHEMA "${schema}";`);
      await pg.query(`SET search_path TO "${schema}", public;`);
      await pg.query(
        `CREATE TABLE games (
           game_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           game_type VARCHAR(50) NOT NULL DEFAULT 'big2',
           status VARCHAR(20) NOT NULL DEFAULT 'CREATED'
         );`,
      );
      await pg.query(
        `CREATE TABLE player_stats (
           user_id UUID PRIMARY KEY,
           games_played INT NOT NULL DEFAULT 0,
           games_won INT NOT NULL DEFAULT 0,
           games_lost INT NOT NULL DEFAULT 0,
           total_score INT NOT NULL DEFAULT 0,
           last_played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         );`,
      );
      await pg.query(
        `INSERT INTO player_stats (user_id, games_played, games_won, games_lost, total_score)
         VALUES ($1, 4, 3, 1, 25);`,
        [seededUserId],
      );

      // Sanity: the PK starts as single-column (user_id).
      const prePk = await pg.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = '${schema}.player_stats'::regclass AND contype = 'p';`,
      );
      expect(prePk.rows[0]!.def).toBe("PRIMARY KEY (user_id)");

      // 2. Run the REAL 004 migration SQL against this schema.
      //    search_path is already set so the unqualified names resolve here.
      await pg.query(readMigrationSql("004_player_stats_game_type.sql"));

      // 3a. The seeded row is backfilled to 'big2', counters preserved.
      const row = await pg.query<{
        game_type: string;
        games_played: number;
        games_won: number;
        total_score: number;
      }>(
        `SELECT game_type, games_played, games_won, total_score
         FROM player_stats WHERE user_id = $1;`,
        [seededUserId],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]!.game_type).toBe("big2");
      expect(row.rows[0]!.games_played).toBe(4);
      expect(row.rows[0]!.games_won).toBe(3);
      expect(row.rows[0]!.total_score).toBe(25);

      // 3b. The PK is now the composite (user_id, game_type).
      const postPk = await pg.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = '${schema}.player_stats'::regclass AND contype = 'p';`,
      );
      expect(postPk.rows[0]!.def).toBe("PRIMARY KEY (user_id, game_type)");

      // 3c. No row has a null/empty game_type.
      const nulls = await pg.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM player_stats
         WHERE game_type IS NULL OR game_type = '';`,
      );
      expect(nulls.rows[0]!.n).toBe("0");
    } finally {
      // Reset search_path before dropping the schema, then clean up.
      await pg.query(`SET search_path TO public;`);
      await pg.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
      await pg.end();
    }
  });
});

// ---------------------------------------------------------------------------
// 006: Composite-PK repair.
//
// 004 dropped the PK by a hardcoded name ('player_stats_pkey'). On prod the
// original PK was named 'player_stats_pkey1' (TypeORM-created), so 004 silently
// left a single-column PRIMARY KEY (user_id) -- breaking 005's
// ON CONFLICT (user_id, game_type). 006 repoints by the ACTUAL constraint name
// and is a no-op where the composite PK already exists.
//
// A clean `supabase start` already has the correct composite PK, so this test
// self-materializes BOTH the prod-like broken state and the fresh-like correct
// state in dedicated throwaway schemas, runs the REAL 006 SQL against each
// (search_path-scoped, exactly like the I4 harness), and asserts the outcome.
// Self-contained: each schema is created and dropped within the test.
// ---------------------------------------------------------------------------

describe("Migration 006 composite-PK repair", () => {
  it("prod-like: repoints a single-column PK named 'player_stats_pkey1' to the composite (user_id, game_type) named 'player_stats_pkey'", async () => {
    const schema = `lld66_006_prod_${Date.now().toString(36)}`;
    const pg = makePgClient();
    await pg.connect();

    try {
      // 1. Materialize the post-004-on-prod state in an isolated schema:
      //    game_type is present (004 steps 2/3 worked), but the PK is still the
      //    single-column 'player_stats_pkey1' (004 step 4 silently skipped).
      await pg.query(`CREATE SCHEMA "${schema}";`);
      await pg.query(`SET search_path TO "${schema}", public;`);
      await pg.query(
        `CREATE TABLE player_stats (
           user_id UUID NOT NULL,
           game_type VARCHAR(50) NOT NULL,
           games_played INT NOT NULL DEFAULT 0,
           games_won INT NOT NULL DEFAULT 0,
           games_lost INT NOT NULL DEFAULT 0,
           total_score INT NOT NULL DEFAULT 0,
           last_played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           CONSTRAINT player_stats_pkey1 PRIMARY KEY (user_id)
         );`,
      );

      // Sanity: the PK starts as a single-column PK with the prod-only name.
      const prePk = await pg.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = '${schema}.player_stats'::regclass AND contype = 'p';`,
      );
      expect(prePk.rows).toHaveLength(1);
      expect(prePk.rows[0]!.conname).toBe("player_stats_pkey1");
      expect(prePk.rows[0]!.def).toBe("PRIMARY KEY (user_id)");

      // 2. Run the REAL 006 migration SQL against this schema.
      await pg.query(readMigrationSql("006_fix_player_stats_composite_pk.sql"));

      // 3. The PK is now the composite (user_id, game_type), named
      //    'player_stats_pkey', and the old prod-only name is gone.
      const postPk = await pg.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = '${schema}.player_stats'::regclass AND contype = 'p';`,
      );
      expect(postPk.rows).toHaveLength(1);
      expect(postPk.rows[0]!.conname).toBe("player_stats_pkey");
      expect(postPk.rows[0]!.def).toBe("PRIMARY KEY (user_id, game_type)");
    } finally {
      await pg.query(`SET search_path TO public;`);
      await pg.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
      await pg.end();
    }
  });

  it("fresh-like: is a no-op (and idempotent) when the composite PK already exists", async () => {
    const schema = `lld66_006_fresh_${Date.now().toString(36)}`;
    const pg = makePgClient();
    await pg.connect();

    try {
      // 1. Materialize the post-004-on-fresh state: the PK is already the
      //    composite (user_id, game_type) named 'player_stats_pkey'.
      await pg.query(`CREATE SCHEMA "${schema}";`);
      await pg.query(`SET search_path TO "${schema}", public;`);
      await pg.query(
        `CREATE TABLE player_stats (
           user_id UUID NOT NULL,
           game_type VARCHAR(50) NOT NULL,
           games_played INT NOT NULL DEFAULT 0,
           games_won INT NOT NULL DEFAULT 0,
           games_lost INT NOT NULL DEFAULT 0,
           total_score INT NOT NULL DEFAULT 0,
           last_played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           CONSTRAINT player_stats_pkey PRIMARY KEY (user_id, game_type)
         );`,
      );

      // Capture the PK's OID so we can prove 006 did NOT drop and recreate it
      // (a no-op leaves the original constraint object untouched).
      const beforeOid = await pg.query<{ oid: string }>(
        `SELECT oid::text AS oid FROM pg_constraint
         WHERE conrelid = '${schema}.player_stats'::regclass AND contype = 'p';`,
      );
      expect(beforeOid.rows).toHaveLength(1);

      // 2. Run 006 twice to prove it is a no-op AND idempotent.
      await pg.query(readMigrationSql("006_fix_player_stats_composite_pk.sql"));
      await pg.query(readMigrationSql("006_fix_player_stats_composite_pk.sql"));

      // 3. Still exactly one PK: composite, conventionally named, and the SAME
      //    constraint object (OID unchanged) -- proving it was never recreated.
      const afterPk = await pg.query<{
        oid: string;
        conname: string;
        def: string;
      }>(
        `SELECT oid::text AS oid, conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
         WHERE conrelid = '${schema}.player_stats'::regclass AND contype = 'p';`,
      );
      expect(afterPk.rows).toHaveLength(1);
      expect(afterPk.rows[0]!.conname).toBe("player_stats_pkey");
      expect(afterPk.rows[0]!.def).toBe("PRIMARY KEY (user_id, game_type)");
      expect(afterPk.rows[0]!.oid).toBe(beforeOid.rows[0]!.oid);
    } finally {
      await pg.query(`SET search_path TO public;`);
      await pg.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
      await pg.end();
    }
  });
});
