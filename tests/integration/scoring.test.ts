import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Card, PlayerView } from "../../src/shared/engine-types.js";
import type { Big2PublicState } from "../../src/shared/big2-types.js";
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

// ---------------------------------------------------------------------------
// Shared card-play helpers
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

async function playGameToCompletion(
  ctx: TestServerContext,
  userTokens: { id: string; accessToken: string }[],
  gameId: string,
): Promise<PlayerView> {
  const playerIds = userTokens.map((u) => u.id);

  const sockets: TypedClientSocket[] = await Promise.all(
    userTokens.map((u) =>
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
    for (let i = 0; i < userTokens.length; i++) {
      playerStates.set(playerIds[i]!, initialStates[i]!);
    }

    for (let i = 0; i < userTokens.length; i++) {
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

    const finalState = [...playerStates.values()][0]!;
    if (finalState.status !== "COMPLETED") {
      throw new Error(
        `Game did not complete within ${MAX_TURNS} turns (status: ${finalState.status})`,
      );
    }

    return finalState;
  } finally {
    sockets.forEach(disconnectSocket);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Placement scoring integration", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("4-player game produces scores [5, 3, 1, 0] in placement order", async () => {
    const users = await Promise.all([
      createTestUser("ScoreP1"),
      createTestUser("ScoreP2"),
      createTestUser("ScoreP3"),
      createTestUser("ScoreP4"),
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

    const finalState = await playGameToCompletion(ctx, users, gameId);

    expect(finalState.status).toBe("COMPLETED");
    expect(finalState.scores).not.toBeNull();
    expect(finalState.scores).toHaveLength(4);

    const scoreValues = finalState
      .scores!.map((s) => s.score)
      .sort((a, b) => b - a);
    expect(scoreValues).toEqual([5, 3, 1, 0]);

    // Winner's score is 5
    const winnerScore = finalState.scores!.find(
      (s) => s.playerId === finalState.winner,
    );
    expect(winnerScore?.score).toBe(5);
  });

  it("2-player game produces scores [5, 0]", async () => {
    const [user1, user2] = await Promise.all([
      createTestUser("Score2P1"),
      createTestUser("Score2P2"),
    ]);

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${user1.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 30 });
    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${user2.accessToken}`)
      .send({ gameId });

    const finalState = await playGameToCompletion(ctx, [user1, user2], gameId);

    expect(finalState.status).toBe("COMPLETED");
    expect(finalState.scores).not.toBeNull();
    expect(finalState.scores).toHaveLength(2);

    const scoreValues = finalState
      .scores!.map((s) => s.score)
      .sort((a, b) => b - a);
    expect(scoreValues).toEqual([5, 0]);

    const winnerScore = finalState.scores!.find(
      (s) => s.playerId === finalState.winner,
    );
    expect(winnerScore?.score).toBe(5);
  });
});
