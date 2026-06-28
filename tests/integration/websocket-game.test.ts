import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { io as ioClient } from "socket.io-client";
import request from "supertest";
import type { Card, PlayerView } from "../../src/shared/engine-types.js";
import type { Big2PublicState, Big2Play } from "../../src/shared/big2-types.js";
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

// Rank order for Big2: 3 is lowest, 2 is highest.
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

function cardBeats(candidate: Card, lastPlay: Big2Play): boolean {
  if (lastPlay.handType.kind !== "single") return false;
  return cardValue(candidate) > cardValue(lastPlay.handType.card);
}

/**
 * Pick cards to play given the current player's hand and the public state.
 * Returns an array of cards to play, or null if the strategy is to pass.
 *
 * Strategy:
 * - isFirstPlayOfGame: play the lowest card in hand (it must be the lowest dealt card)
 * - isFreePlay: play the lowest single card in hand
 * - can beat last single: play the lowest card in hand that beats it
 * - otherwise: should not be called (caller checks for pass first)
 */
function pickCardsToPlay(
  hand: readonly Card[],
  publicState: Big2PublicState,
): readonly Card[] | null {
  const sorted = [...hand].sort((a, b) => cardValue(a) - cardValue(b));

  if (publicState.isFirstPlayOfGame || publicState.isFreePlay) {
    // Play the lowest card as a single
    const lowest = sorted[0];
    if (!lowest) return null;
    return [lowest];
  }

  // Must beat last play — only support single-card last plays
  // (if last play is multi-card, fall back to lowest beating single)
  const lastPlay = publicState.lastPlay;
  if (!lastPlay) {
    return sorted[0] ? [sorted[0]] : null;
  }

  if (lastPlay.handType.kind === "single") {
    const beating = sorted.find((c) => cardBeats(c, lastPlay));
    return beating ? [beating] : null;
  }

  // Multi-card last play: can't easily find a beat — return null (caller must pass)
  return null;
}

describe("WebSocket game flow", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("establishes authenticated WebSocket connection", async () => {
    const user = await createTestUser("WsConnectUser");
    const socket = await createAuthenticatedSocket(
      ctx.baseUrl,
      user.accessToken,
    );
    expect(socket.connected).toBe(true);
    disconnectSocket(socket);
  });

  it("rejects WebSocket connection with invalid token", async () => {
    const socket = ioClient(ctx.baseUrl, {
      auth: { token: "garbage-token-not-valid" },
      transports: ["websocket"],
      reconnection: false,
    });

    const err = await new Promise<Error>((resolve, reject) => {
      socket.once("connect", () =>
        reject(new Error("Expected connection to fail")),
      );
      socket.once("connect_error", resolve);
    });

    expect(err.message).toContain("UNAUTHORIZED");
    socket.disconnect();
  });

  it("plays a complete Big2 game via WebSocket", async () => {
    // Create 4 users
    const users = await Promise.all([
      createTestUser("WsPlayer1"),
      createTestUser("WsPlayer2"),
      createTestUser("WsPlayer3"),
      createTestUser("WsPlayer4"),
    ]);

    // User 1 creates a 4-player game via REST
    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${users[0]!.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });

    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    // Users 2-4 join via REST
    for (let i = 1; i < 4; i++) {
      const joinRes = await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${users[i]!.accessToken}`)
        .send({ gameId });
      expect(joinRes.status).toBe(200);
    }

    // All 4 connect via WebSocket
    const sockets: TypedClientSocket[] = await Promise.all(
      users.map((u) => createAuthenticatedSocket(ctx.baseUrl, u.accessToken)),
    );

    try {
      const playerIds = users.map((u) => u.id);
      const playerStates = new Map<string, PlayerView>();

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

      // Set up state listeners before starting
      const statePromises = sockets.map(
        (socket) =>
          new Promise<PlayerView>((resolve) => {
            socket.once("game:state", resolve);
          }),
      );

      // User 1 starts the game
      await new Promise<void>((resolve, reject) => {
        sockets[0]!.emit("game:start", { gameId }, (ack) => {
          if (ack.success) resolve();
          else reject(new Error(`game:start failed: ${ack.error}`));
        });
      });

      // Wait for all players to receive initial state
      const initialStates = await Promise.all(statePromises);

      for (const state of initialStates) {
        expect(state.status).toBe("IN_PROGRESS");
        expect(state.you.hand.length).toBeGreaterThan(0);
        expect(state.players.length).toBe(4);
      }

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

        // Invariant checks
        expect(currentState.players.length).toBe(4);
        expect(["IN_PROGRESS", "COMPLETED"]).toContain(currentState.status);
        expect(validActions.length).toBeGreaterThan(0);

        const socket = sockets[currentUserIndex]!;
        const publicState =
          currentState.gameSpecificPublicState as Big2PublicState;

        // trickStartIndex invariants (LLD 55): published, bounded by the
        // public playHistory, and the slice reflects only the current trick.
        expect(typeof publicState.trickStartIndex).toBe("number");
        expect(publicState.trickStartIndex).toBeGreaterThanOrEqual(0);
        expect(publicState.trickStartIndex).toBeLessThanOrEqual(
          publicState.playHistory.length,
        );
        // On a free play / first play the current trick has no lead yet, so
        // the engine boundary sits at the end of history (empty current trick).
        if (publicState.isFreePlay || publicState.isFirstPlayOfGame) {
          expect(publicState.trickStartIndex).toBe(
            publicState.playHistory.length,
          );
        }

        const hasPass = validActions.some((a) => a.type === "pass");
        const hasPlayCards = validActions.some((a) => a.type === "playCards");

        // Set up next state listeners before emitting action
        const nextStatePromises = sockets.map(
          (s, idx) =>
            new Promise<{ userId: string; state: PlayerView }>((resolve) => {
              s.once("game:state", (state) => {
                resolve({ userId: playerIds[idx]!, state });
              });
            }),
        );

        let actionSuccess = false;

        if (
          hasPass &&
          !publicState.isFreePlay &&
          !publicState.isFirstPlayOfGame
        ) {
          // Prefer pass to keep things simple
          const ack = await new Promise<{ success: boolean; error?: string }>(
            (resolve) => {
              socket.emit(
                "game:action",
                { gameId, action: { type: "pass", playerId: currentPlayerId } },
                resolve,
              );
            },
          );
          actionSuccess = ack.success;
        } else if (hasPlayCards) {
          // Must play — pick cards using our strategy
          const cards = pickCardsToPlay(currentState.you.hand, publicState);
          if (!cards) {
            // Strategy couldn't find cards — fall back to pass if available
            const ack = await new Promise<{ success: boolean; error?: string }>(
              (resolve) => {
                socket.emit(
                  "game:action",
                  {
                    gameId,
                    action: { type: "pass", playerId: currentPlayerId },
                  },
                  resolve,
                );
              },
            );
            actionSuccess = ack.success;
          } else {
            const ack = await new Promise<{ success: boolean; error?: string }>(
              (resolve) => {
                socket.emit(
                  "game:action",
                  {
                    gameId,
                    action: {
                      type: "playCards",
                      playerId: currentPlayerId,
                      cards,
                    },
                  },
                  resolve,
                );
              },
            );
            actionSuccess = ack.success;
          }
        } else {
          // Only pass available
          const ack = await new Promise<{ success: boolean; error?: string }>(
            (resolve) => {
              socket.emit(
                "game:action",
                { gameId, action: { type: "pass", playerId: currentPlayerId } },
                resolve,
              );
            },
          );
          actionSuccess = ack.success;
        }

        expect(actionSuccess).toBe(true);

        const nextStates = await Promise.all(nextStatePromises);
        for (const { userId, state } of nextStates) {
          playerStates.set(userId, state);
        }

        turnCount++;
      }

      const finalState = [...playerStates.values()][0]!;
      expect(turnCount).toBeLessThan(MAX_TURNS);
      expect(finalState.status).toBe("COMPLETED");
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("guest connects via WebSocket and plays", async () => {
    const user1 = await createTestUser("WsGuestHost");
    const user2 = await createTestUser("WsGuestPlayer2");

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${user1.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });

    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${user2.accessToken}`)
      .send({ gameId });

    const guest = await createTestGuest(ctx.app, gameId, "GuestWsPlayer");
    const guestJoinRes = await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${guest.token}`)
      .send({ gameId });
    expect(guestJoinRes.status).toBe(200);

    const user4 = await createTestUser("WsGuestPlayer4");
    await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${user4.accessToken}`)
      .send({ gameId });

    const socket1 = await createAuthenticatedSocket(
      ctx.baseUrl,
      user1.accessToken,
    );
    const socket2 = await createAuthenticatedSocket(
      ctx.baseUrl,
      user2.accessToken,
    );
    const socketGuest = await createAuthenticatedSocket(
      ctx.baseUrl,
      guest.token,
    );
    const socket4 = await createAuthenticatedSocket(
      ctx.baseUrl,
      user4.accessToken,
    );
    const allSockets = [socket1, socket2, socketGuest, socket4];

    try {
      await Promise.all(
        allSockets.map(
          (socket) =>
            new Promise<void>((resolve, reject) => {
              socket.emit("game:join", { gameId, role: "player" }, (ack) => {
                if (ack.success) resolve();
                else reject(new Error(`game:join failed: ${ack.error}`));
              });
            }),
        ),
      );

      const statePromises = allSockets.map(
        (socket) =>
          new Promise<PlayerView>((resolve) => {
            socket.once("game:state", resolve);
          }),
      );

      await new Promise<void>((resolve, reject) => {
        socket1.emit("game:start", { gameId }, (ack) => {
          if (ack.success) resolve();
          else reject(new Error(`game:start failed: ${ack.error}`));
        });
      });

      const allStates = await Promise.all(statePromises);

      // Verify guest received game state with a hand
      const guestState = allStates[2]!;
      expect(guestState.status).toBe("IN_PROGRESS");
      expect(guestState.you.hand.length).toBeGreaterThan(0);
      expect(guestState.you.playerId).toBe(guest.guestId);
      expect(guestState.players.length).toBe(4);

      // If it's the guest's turn, play a valid action
      const guestPlayerIndex = guestState.players.findIndex(
        (p) => p.playerId === guest.guestId,
      );
      if (guestState.currentPlayerIndex === guestPlayerIndex) {
        const validActions = guestState.validActions;
        expect(validActions.length).toBeGreaterThan(0);

        const publicState =
          guestState.gameSpecificPublicState as Big2PublicState;
        const hasPass = validActions.some((a) => a.type === "pass");

        let action: Record<string, unknown>;
        if (
          hasPass &&
          !publicState.isFreePlay &&
          !publicState.isFirstPlayOfGame
        ) {
          action = { type: "pass", playerId: guest.guestId };
        } else {
          const cards = pickCardsToPlay(guestState.you.hand, publicState);
          if (cards) {
            action = {
              type: "playCards",
              playerId: guest.guestId,
              cards,
            };
          } else {
            action = { type: "pass", playerId: guest.guestId };
          }
        }

        const ack = await new Promise<{ success: boolean; error?: string }>(
          (resolve) => {
            socketGuest.emit("game:action", { gameId, action }, resolve);
          },
        );
        expect(ack.success).toBe(true);
      }
      // If not guest's turn, state receipt is sufficient verification
    } finally {
      allSockets.forEach(disconnectSocket);
    }
  });
});
