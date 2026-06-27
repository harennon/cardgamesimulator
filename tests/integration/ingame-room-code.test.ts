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
  EnrichedSpectatorView,
} from "../../src/shared/socket-events.js";
import type { Card } from "../../src/shared/engine-types.js";
import type { Big2PublicState } from "../../src/shared/big2-types.js";

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

async function joinGameRoom(
  sockets: TypedClientSocket[],
  gameId: string,
): Promise<void> {
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
}

async function startGame(
  sockets: TypedClientSocket[],
  gameId: string,
): Promise<EnrichedPlayerView[]> {
  const statePromises = sockets.map(
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

  return Promise.all(statePromises);
}

/** Set up a 2-player game, return sockets, gameId, the createGame joinCode, and initial join-time states. */
async function setupInProgressGame(ctx: TestServerContext): Promise<{
  sockets: TypedClientSocket[];
  gameId: string;
  joinCode: string;
  initialStates: EnrichedPlayerView[];
}> {
  const [userA, userB] = await Promise.all([
    createTestUser("RoomCodeSetupA"),
    createTestUser("RoomCodeSetupB"),
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

  await joinGameRoom(sockets, gameId);
  const initialStates = await startGame(sockets, gameId);

  return { sockets, gameId, joinCode, initialStates };
}

describe("In-game room code integration", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
    await new Promise((r) => setTimeout(r, 200));
  });

  it("join-time game:state carries the game's joinCode", async () => {
    const { sockets, joinCode, initialStates } = await setupInProgressGame(ctx);
    try {
      expect(joinCode).toMatch(/^[A-Z0-9]{4}$/);
      for (const state of initialStates) {
        expect(state.joinCode).toBe(joinCode);
      }
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("REST getGameState returns the joinCode", async () => {
    const { sockets, gameId, joinCode } = await setupInProgressGame(ctx);
    const user = await createTestUser("RoomCodeRestReader");
    try {
      // Use a player's own token (the host) via a fresh request — reuse host
      // by reading the game state with the existing host session is simplest:
      const stateRes = await request(ctx.app)
        .get(`/getGameState?gameId=${gameId}`)
        .set(
          "Authorization",
          // any authenticated user can read game state metadata in this API
          `Bearer ${user.accessToken}`,
        );

      expect(stateRes.status).toBe(200);
      const gameState = stateRes.body.gameState as { joinCode: string | null };
      expect(gameState.joinCode).toBe(joinCode);
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("broadcastGameState (post-action) per-player game:state carries the same joinCode", async () => {
    const { sockets, gameId, joinCode, initialStates } =
      await setupInProgressGame(ctx);
    try {
      const currentPlayerIndex = initialStates[0]!.currentPlayerIndex;
      const currentSocket = sockets[currentPlayerIndex]!;
      const currentView = initialStates[currentPlayerIndex]!;

      // First play of the game is always a free play — play the lowest card.
      const sorted = [...currentView.you.hand].sort(
        (a, b) => cardValue(a) - cardValue(b),
      );
      const lowest = sorted[0]!;

      // Listen for the post-action broadcast on BOTH sockets before acting.
      const nextStatesPromise = Promise.all(
        sockets.map(
          (s) =>
            new Promise<EnrichedPlayerView>((resolve) => {
              s.once("game:state", resolve);
            }),
        ),
      );

      await new Promise<void>((resolve, reject) => {
        currentSocket.emit(
          "game:action",
          {
            gameId,
            action: { type: "playCards", playerId: "", cards: [lowest] },
          },
          (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`action failed: ${ack.error}`));
          },
        );
      });

      const broadcastStates = await nextStatesPromise;
      // This is the regression-critical path: broadcastGameState has no Game row
      // from getGameState and must load it separately to include joinCode.
      for (const state of broadcastStates) {
        expect(state.joinCode).toBe(joinCode);
      }
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("game:spectatorState does NOT include joinCode (out of scope)", async () => {
    const { sockets, gameId } = await setupInProgressGame(ctx);
    const spectatorUser = await createTestUser("RoomCodeSpectator");
    const spectatorSocket = await createAuthenticatedSocket(
      ctx.baseUrl,
      spectatorUser.accessToken,
    );

    try {
      const spectatorState = await new Promise<EnrichedSpectatorView>(
        (resolve, reject) => {
          spectatorSocket.once("game:spectatorState", resolve);
          spectatorSocket.emit(
            "game:join",
            { gameId, role: "spectator" },
            (ack) => {
              if (!ack.success) {
                reject(new Error(`spectator join failed: ${ack.error}`));
              }
            },
          );
        },
      );

      expect(spectatorState.status).toBe("IN_PROGRESS");
      expect("joinCode" in spectatorState).toBe(false);
    } finally {
      sockets.forEach(disconnectSocket);
      disconnectSocket(spectatorSocket);
    }
  });

  it("adding joinCode does not leak opponent hands into the per-player view", async () => {
    const { sockets, initialStates } = await setupInProgressGame(ctx);
    try {
      // Information-hiding regression: each player only sees their own hand;
      // opponents expose only a cardCount, never their cards.
      for (const state of initialStates) {
        expect(state.joinCode).toBeTypeOf("string");
        expect(state.you.hand.length).toBeGreaterThan(0);
        for (const opponent of state.players) {
          if (opponent.playerId === state.you.playerId) continue;
          expect(opponent).not.toHaveProperty("hand");
          const publicState = state.gameSpecificPublicState as Big2PublicState;
          expect(publicState).toBeDefined();
        }
      }
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });
});
