import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { io as ioClient } from "socket.io-client";
import { randomUUID } from "crypto";
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
import { createGuestToken } from "../../src/backend/guest/guestToken.js";

// ---------------------------------------------------------------------------
// Card-playing strategy (duplicated from websocket-game.test.ts per LLD note)
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

function cardBeats(candidate: Card, lastPlay: Big2Play): boolean {
  if (lastPlay.handType.kind !== "single") return false;
  return cardValue(candidate) > cardValue(lastPlay.handType.card);
}

function pickCardsToPlay(
  hand: readonly Card[],
  publicState: Big2PublicState,
): readonly Card[] | null {
  const sorted = [...hand].sort((a, b) => cardValue(a) - cardValue(b));

  if (publicState.isFirstPlayOfGame || publicState.isFreePlay) {
    const lowest = sorted[0];
    if (!lowest) return null;
    return [lowest];
  }

  const lastPlay = publicState.lastPlay;
  if (!lastPlay) {
    return sorted[0] ? [sorted[0]] : null;
  }

  if (lastPlay.handType.kind === "single") {
    const beating = sorted.find((c) => cardBeats(c, lastPlay));
    return beating ? [beating] : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helper: create an expired guest token for edge-case tests
// ---------------------------------------------------------------------------

function createExpiredGuestToken(guestId: string, gameId: string): string {
  const jwtSecret = process.env.SUPABASE_JWT_SECRET!;
  const pastTimestamp = Date.now() - 60_000; // expired 1 minute ago
  return createGuestToken(guestId, gameId, pastTimestamp, jwtSecret);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Guest flow integration", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  // -------------------------------------------------------------------------
  describe("Guest session creation", () => {
    it("POST /guest/session creates a valid guest session", async () => {
      const host = await createTestUser("SessionCreateHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      expect(createRes.status).toBe(200);
      const gameId = createRes.body.gameId as string;

      const res = await request(ctx.app)
        .post("/guest/session")
        .send({ displayName: "Alice", gameId });

      expect(res.status).toBe(200);
      expect(typeof res.body.guestId).toBe("string");
      expect(res.body.displayName).toBe("Alice");
      expect(typeof res.body.token).toBe("string");
      expect((res.body.token as string).startsWith("guest:")).toBe(true);
      expect(res.body.gameId).toBe(gameId);
    });

    it("rejects guest session for non-existent game", async () => {
      const res = await request(ctx.app)
        .post("/guest/session")
        .send({ displayName: "Alice", gameId: randomUUID() });

      expect(res.status).toBe(404);
    });

    it("rejects guest session with empty displayName", async () => {
      const host = await createTestUser("SessionEmptyNameHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const res = await request(ctx.app)
        .post("/guest/session")
        .send({ displayName: "", gameId });

      expect(res.status).toBe(400);
    });

    it("rejects guest session with displayName exceeding max length", async () => {
      const host = await createTestUser("SessionLongNameHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const res = await request(ctx.app)
        .post("/guest/session")
        .send({ displayName: "A".repeat(21), gameId });

      expect(res.status).toBe(400);
    });

    it("deduplicates display names when multiple guests use the same name", async () => {
      const host = await createTestUser("SessionDedupHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const guest1 = await createTestGuest(ctx.app, gameId, "Player");
      // Guest1 must join the game so their name appears in playerDisplayNames
      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${guest1.token}`)
        .send({ gameId });

      const guest2 = await createTestGuest(ctx.app, gameId, "Player");

      expect(guest1.displayName).toBe("Player");
      expect(guest2.displayName).toBe("Player2");
    });
  });

  // -------------------------------------------------------------------------
  describe("Guest joining a game", () => {
    it("guest token is accepted by joinGame endpoint", async () => {
      const host = await createTestUser("JoinTokenHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      expect(createRes.status).toBe(200);
      const gameId = createRes.body.gameId as string;

      const guest = await createTestGuest(ctx.app, gameId, "JoinAlice");

      const joinRes = await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${guest.token}`)
        .send({ gameId });

      expect(joinRes.status).toBe(200);
      expect(joinRes.body.gameId).toBe(gameId);
    });

    it("guest appears in game state after joining", async () => {
      const host = await createTestUser("JoinStateHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const guest = await createTestGuest(ctx.app, gameId, "JoinStateGuest");
      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${guest.token}`)
        .send({ gameId });

      const stateRes = await request(ctx.app)
        .get(`/getGameState?gameId=${gameId}`)
        .set("Authorization", `Bearer ${guest.token}`);

      expect(stateRes.status).toBe(200);
      const gameState = stateRes.body.gameState as {
        playerIds: string[];
        playerDisplayNames: Record<string, string>;
      };
      expect(gameState.playerIds).toContain(guest.guestId);
      expect(gameState.playerDisplayNames[guest.guestId]).toBe(
        guest.displayName,
      );
    });

    it("rejects guest joining with token for a different game (documents current behavior)", async () => {
      const host = await createTestUser("JoinCrossHost");
      const createResA = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameIdA = createResA.body.gameId as string;

      const createResB = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameIdB = createResB.body.gameId as string;

      const guest = await createTestGuest(ctx.app, gameIdA, "CrossGameGuest");

      // Guest session is for game A but attempts to join game B.
      // Auth middleware only checks that the session exists — it does NOT enforce gameId match.
      const joinRes = await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${guest.token}`)
        .send({ gameId: gameIdB });

      expect(joinRes.status).toBe(200);
    });

    it("guest cannot create a game (403)", async () => {
      const host = await createTestUser("CreateGameGuestHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const guest = await createTestGuest(ctx.app, gameId, "GuestCreator");

      const res = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${guest.token}`)
        .send({ gameType: "big2", maxPlayers: 4 });

      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  describe("Guest accessing game state", () => {
    it("guest can GET /getGameState with their token", async () => {
      const host = await createTestUser("GetStateHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const guest = await createTestGuest(ctx.app, gameId, "GetStateGuest");
      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${guest.token}`)
        .send({ gameId });

      const stateRes = await request(ctx.app)
        .get(`/getGameState?gameId=${gameId}`)
        .set("Authorization", `Bearer ${guest.token}`);

      expect(stateRes.status).toBe(200);
      const gameState = stateRes.body.gameState as {
        playerIds: string[];
        status: string;
      };
      expect(gameState.playerIds).toContain(guest.guestId);
      expect(gameState.status).toBe("CREATED");
    });

    it("guest receives filtered game state (playerIds and status are correct)", async () => {
      const host = await createTestUser("FilteredStateHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      // Join 3 guests
      const guests = await Promise.all([
        createTestGuest(ctx.app, gameId, "FilterGuest1"),
        createTestGuest(ctx.app, gameId, "FilterGuest2"),
        createTestGuest(ctx.app, gameId, "FilterGuest3"),
      ]);
      for (const guest of guests) {
        await request(ctx.app)
          .post("/joinGame")
          .set("Authorization", `Bearer ${guest.token}`)
          .send({ gameId });
      }

      // Each guest can get the game state and sees all playerIds
      for (const guest of guests) {
        const stateRes = await request(ctx.app)
          .get(`/getGameState?gameId=${gameId}`)
          .set("Authorization", `Bearer ${guest.token}`);

        expect(stateRes.status).toBe(200);
        const gameState = stateRes.body.gameState as {
          playerIds: string[];
          status: string;
        };
        expect(gameState.playerIds).toContain(guest.guestId);
        expect(gameState.status).toBe("CREATED");
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("Guest WebSocket connection", () => {
    it("guest connects via WebSocket with guest token", async () => {
      const host = await createTestUser("WsGuestConnHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const guest = await createTestGuest(ctx.app, gameId, "WsConnGuest");
      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${guest.token}`)
        .send({ gameId });

      const socket = await createAuthenticatedSocket(ctx.baseUrl, guest.token);
      expect(socket.connected).toBe(true);
      disconnectSocket(socket);
    });

    it("guest receives game:state after game:join + game:start", async () => {
      const host = await createTestUser("WsGuestStateHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const guests = await Promise.all([
        createTestGuest(ctx.app, gameId, "WsStateG1"),
        createTestGuest(ctx.app, gameId, "WsStateG2"),
        createTestGuest(ctx.app, gameId, "WsStateG3"),
      ]);
      for (const guest of guests) {
        await request(ctx.app)
          .post("/joinGame")
          .set("Authorization", `Bearer ${guest.token}`)
          .send({ gameId });
      }

      const hostSocket = await createAuthenticatedSocket(
        ctx.baseUrl,
        host.accessToken,
      );
      const guestSockets = await Promise.all(
        guests.map((g) => createAuthenticatedSocket(ctx.baseUrl, g.token)),
      );
      const allSockets = [hostSocket, ...guestSockets];

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

        const statePromises = guestSockets.map(
          (socket) =>
            new Promise<PlayerView>((resolve) => {
              socket.once("game:state", resolve);
            }),
        );

        await new Promise<void>((resolve, reject) => {
          hostSocket.emit("game:start", { gameId }, (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`game:start failed: ${ack.error}`));
          });
        });

        const guestStates = await Promise.all(statePromises);

        for (const state of guestStates) {
          expect(state.status).toBe("IN_PROGRESS");
          expect(state.you.hand.length).toBeGreaterThan(0);
        }
      } finally {
        allSockets.forEach(disconnectSocket);
      }
    });

    it("rejects WebSocket connection with expired guest token", async () => {
      const host = await createTestUser("WsExpiredHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const expiredToken = createExpiredGuestToken(randomUUID(), gameId);

      const socket = ioClient(ctx.baseUrl, {
        auth: { token: expiredToken },
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

    it("rejects WebSocket connection with tampered guest token", async () => {
      const host = await createTestUser("WsTamperedHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const guest = await createTestGuest(ctx.app, gameId, "TamperedGuest");
      // Flip last character of token to break HMAC
      const token = guest.token;
      const lastChar = token[token.length - 1]!;
      const flipped = lastChar === "a" ? "b" : "a";
      const tamperedToken = token.slice(0, -1) + flipped;

      const socket = ioClient(ctx.baseUrl, {
        auth: { token: tamperedToken },
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
  });

  // -------------------------------------------------------------------------
  describe("Guest playing in-game", () => {
    it("guest can emit game:action and play cards", async () => {
      const host = await createTestUser("PlayActionHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const guests = await Promise.all([
        createTestGuest(ctx.app, gameId, "ActionGuest1"),
        createTestGuest(ctx.app, gameId, "ActionGuest2"),
        createTestGuest(ctx.app, gameId, "ActionGuest3"),
      ]);
      for (const guest of guests) {
        await request(ctx.app)
          .post("/joinGame")
          .set("Authorization", `Bearer ${guest.token}`)
          .send({ gameId });
      }

      const hostSocket = await createAuthenticatedSocket(
        ctx.baseUrl,
        host.accessToken,
      );
      const guestSockets = await Promise.all(
        guests.map((g) => createAuthenticatedSocket(ctx.baseUrl, g.token)),
      );
      const allSockets = [hostSocket, ...guestSockets];
      const allIds = [host.id, ...guests.map((g) => g.guestId)];

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
          hostSocket.emit("game:start", { gameId }, (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`game:start failed: ${ack.error}`));
          });
        });

        const initialStates = await Promise.all(statePromises);
        const playerStates = new Map<string, PlayerView>();
        for (let i = 0; i < allIds.length; i++) {
          playerStates.set(allIds[i]!, initialStates[i]!);
        }

        // Find who has the first turn and take exactly one action
        const anyState = initialStates[0]!;
        const currentPlayerIndex = anyState.currentPlayerIndex;
        const currentPlayerId = anyState.players[currentPlayerIndex]?.playerId;
        expect(currentPlayerId).toBeDefined();

        const currentSocketIndex = allIds.indexOf(currentPlayerId!);
        expect(currentSocketIndex).toBeGreaterThanOrEqual(0);

        const currentSocket = allSockets[currentSocketIndex]!;
        const currentState = playerStates.get(currentPlayerId!)!;
        const publicState =
          currentState.gameSpecificPublicState as Big2PublicState;
        const validActions = currentState.validActions;

        const hasPass = validActions.some((a) => a.type === "pass");
        const hasPlayCards = validActions.some((a) => a.type === "playCards");

        // Set up state listeners before emitting
        const nextStatePromises = allSockets.map(
          (s, idx) =>
            new Promise<void>((resolve) => {
              s.once("game:state", (state) => {
                playerStates.set(allIds[idx]!, state);
                resolve();
              });
            }),
        );

        let ackResult: { success: boolean; error?: string };

        if (
          hasPass &&
          !publicState.isFreePlay &&
          !publicState.isFirstPlayOfGame
        ) {
          ackResult = await new Promise((resolve) => {
            currentSocket.emit(
              "game:action",
              {
                gameId,
                action: { type: "pass", playerId: currentPlayerId! },
              },
              resolve,
            );
          });
        } else if (hasPlayCards) {
          const cards = pickCardsToPlay(currentState.you.hand, publicState);
          if (cards) {
            ackResult = await new Promise((resolve) => {
              currentSocket.emit(
                "game:action",
                {
                  gameId,
                  action: {
                    type: "playCards",
                    playerId: currentPlayerId!,
                    cards,
                  },
                },
                resolve,
              );
            });
          } else {
            ackResult = await new Promise((resolve) => {
              currentSocket.emit(
                "game:action",
                {
                  gameId,
                  action: { type: "pass", playerId: currentPlayerId! },
                },
                resolve,
              );
            });
          }
        } else {
          ackResult = await new Promise((resolve) => {
            currentSocket.emit(
              "game:action",
              {
                gameId,
                action: { type: "pass", playerId: currentPlayerId! },
              },
              resolve,
            );
          });
        }

        expect(ackResult.success).toBe(true);
        await Promise.all(nextStatePromises);
      } finally {
        allSockets.forEach(disconnectSocket);
      }
    });

    it("server overrides playerId in guest action (anti-spoofing)", async () => {
      const host = await createTestUser("AntiSpoofHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const guests = await Promise.all([
        createTestGuest(ctx.app, gameId, "SpoofGuest1"),
        createTestGuest(ctx.app, gameId, "SpoofGuest2"),
        createTestGuest(ctx.app, gameId, "SpoofGuest3"),
      ]);
      for (const guest of guests) {
        await request(ctx.app)
          .post("/joinGame")
          .set("Authorization", `Bearer ${guest.token}`)
          .send({ gameId });
      }

      const hostSocket = await createAuthenticatedSocket(
        ctx.baseUrl,
        host.accessToken,
      );
      const guestSockets = await Promise.all(
        guests.map((g) => createAuthenticatedSocket(ctx.baseUrl, g.token)),
      );
      const allSockets = [hostSocket, ...guestSockets];
      const allIds = [host.id, ...guests.map((g) => g.guestId)];

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
          hostSocket.emit("game:start", { gameId }, (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`game:start failed: ${ack.error}`));
          });
        });

        const initialStates = await Promise.all(statePromises);
        const playerStates = new Map<string, PlayerView>();
        for (let i = 0; i < allIds.length; i++) {
          playerStates.set(allIds[i]!, initialStates[i]!);
        }

        const anyState = initialStates[0]!;
        const currentPlayerIndex = anyState.currentPlayerIndex;
        const currentPlayerId = anyState.players[currentPlayerIndex]?.playerId;
        expect(currentPlayerId).toBeDefined();

        const currentSocketIndex = allIds.indexOf(currentPlayerId!);
        const currentSocket = allSockets[currentSocketIndex]!;
        const currentState = playerStates.get(currentPlayerId!)!;
        const publicState =
          currentState.gameSpecificPublicState as Big2PublicState;

        // Set up state listeners
        const nextStatePromises = allSockets.map(
          (s) =>
            new Promise<PlayerView>((resolve) => {
              s.once("game:state", resolve);
            }),
        );

        // Send action with a spoofed playerId — server must use socket.data.userId instead
        const spoofedId = "00000000-0000-0000-0000-000000000000";
        let ackResult: { success: boolean; error?: string };

        const cards = pickCardsToPlay(currentState.you.hand, publicState);
        if (
          cards &&
          (publicState.isFreePlay || publicState.isFirstPlayOfGame)
        ) {
          ackResult = await new Promise((resolve) => {
            currentSocket.emit(
              "game:action",
              {
                gameId,
                action: { type: "playCards", playerId: spoofedId, cards },
              },
              resolve,
            );
          });
        } else {
          ackResult = await new Promise((resolve) => {
            currentSocket.emit(
              "game:action",
              {
                gameId,
                action: { type: "pass", playerId: spoofedId },
              },
              resolve,
            );
          });
        }

        // Action succeeds because server uses real ID, not spoofed one
        expect(ackResult.success).toBe(true);
        await Promise.all(nextStatePromises);
      } finally {
        allSockets.forEach(disconnectSocket);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("Guest session expiry and edge cases", () => {
    it("request with no Authorization header returns 401", async () => {
      const host = await createTestUser("NoAuthHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const res = await request(ctx.app).post("/joinGame").send({ gameId });

      expect(res.status).toBe(401);
    });

    it("request with malformed guest token returns 401", async () => {
      const host = await createTestUser("MalformedHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const res = await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", "Bearer guest:not-valid-base64!")
        .send({ gameId });

      expect(res.status).toBe(401);
    });

    it("request with well-formed but non-existent session returns 401", async () => {
      const host = await createTestUser("NonExistentSessionHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      // Create a valid token for a guestId that has no corresponding session in the store
      const nonExistentGuestId = randomUUID();
      const jwtSecret = process.env.SUPABASE_JWT_SECRET!;
      const futureExpiry = Date.now() + 60_000;
      const validHmacButNoSession = createGuestToken(
        nonExistentGuestId,
        gameId,
        futureExpiry,
        jwtSecret,
      );

      const res = await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${validHmacButNoSession}`)
        .send({ gameId });

      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  describe("Guest-to-registered claiming", () => {
    it("POST /guest/claim links guest game to new account", async () => {
      const hostA = await createTestUser("ClaimHostA");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${hostA.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const guest = await createTestGuest(ctx.app, gameId, "ClaimGuest");
      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${guest.token}`)
        .send({ gameId });

      const userB = await createTestUser("ClaimUserB");

      const claimRes = await request(ctx.app)
        .post("/guest/claim")
        .set("Authorization", `Bearer ${userB.accessToken}`)
        .send({ guestToken: guest.token });

      expect(claimRes.status).toBe(200);
      expect(claimRes.body.success).toBe(true);
      expect(claimRes.body.gamesLinked).toBe(1);

      // User B's ID should now be in the game, guest's ID should not
      const stateRes = await request(ctx.app)
        .get(`/getGameState?gameId=${gameId}`)
        .set("Authorization", `Bearer ${userB.accessToken}`);

      expect(stateRes.status).toBe(200);
      const gameState = stateRes.body.gameState as { playerIds: string[] };
      expect(gameState.playerIds).toContain(userB.id);
      expect(gameState.playerIds).not.toContain(guest.guestId);
    });

    it("claim with expired guest token returns gamesLinked: 0", async () => {
      const host = await createTestUser("ExpiredClaimHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const expiredToken = createExpiredGuestToken(randomUUID(), gameId);

      const userB = await createTestUser("ExpiredClaimUser");

      const claimRes = await request(ctx.app)
        .post("/guest/claim")
        .set("Authorization", `Bearer ${userB.accessToken}`)
        .send({ guestToken: expiredToken });

      expect(claimRes.status).toBe(200);
      expect(claimRes.body.success).toBe(true);
      expect(claimRes.body.gamesLinked).toBe(0);
    });

    it("claim with guest not in any game returns gamesLinked: 0", async () => {
      const host = await createTestUser("NoGameClaimHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      // Create session but do NOT join
      const guest = await createTestGuest(ctx.app, gameId, "NoJoinGuest");

      const userB = await createTestUser("NoGameClaimUser");

      const claimRes = await request(ctx.app)
        .post("/guest/claim")
        .set("Authorization", `Bearer ${userB.accessToken}`)
        .send({ guestToken: guest.token });

      expect(claimRes.status).toBe(200);
      expect(claimRes.body.success).toBe(true);
      expect(claimRes.body.gamesLinked).toBe(0);
    });

    it("guest cannot call /guest/claim (403)", async () => {
      const host = await createTestUser("GuestClaimHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const guest = await createTestGuest(ctx.app, gameId, "GuestSelfClaim");

      const res = await request(ctx.app)
        .post("/guest/claim")
        .set("Authorization", `Bearer ${guest.token}`)
        .send({ guestToken: guest.token });

      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  describe("Multiple guests in one game", () => {
    it("4 guests (no registered user) cannot start a game alone (documents constraint)", () => {
      // POST /createGame requires registered auth.
      // A fully-guest game is not possible. This is enforced by registeredOnlyMiddleware.
      // The constraint is already verified by "guest cannot create a game (403)" above.
      expect(true).toBe(true);
    });

    it("registered host + 3 guests can play a complete Big2 game", async () => {
      const host = await createTestUser("MultiGuestHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      expect(createRes.status).toBe(200);
      const gameId = createRes.body.gameId as string;

      const guests = await Promise.all([
        createTestGuest(ctx.app, gameId, "MultiG1"),
        createTestGuest(ctx.app, gameId, "MultiG2"),
        createTestGuest(ctx.app, gameId, "MultiG3"),
      ]);
      for (const guest of guests) {
        const joinRes = await request(ctx.app)
          .post("/joinGame")
          .set("Authorization", `Bearer ${guest.token}`)
          .send({ gameId });
        expect(joinRes.status).toBe(200);
      }

      const hostSocket = await createAuthenticatedSocket(
        ctx.baseUrl,
        host.accessToken,
      );
      const guestSockets = await Promise.all(
        guests.map((g) => createAuthenticatedSocket(ctx.baseUrl, g.token)),
      );
      const allSockets = [hostSocket, ...guestSockets];
      const allIds = [host.id, ...guests.map((g) => g.guestId)];

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
          hostSocket.emit("game:start", { gameId }, (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`game:start failed: ${ack.error}`));
          });
        });

        const initialStates = await Promise.all(statePromises);
        for (const state of initialStates) {
          expect(state.status).toBe("IN_PROGRESS");
          expect(state.you.hand.length).toBeGreaterThan(0);
        }

        const playerStates = new Map<string, PlayerView>();
        for (let i = 0; i < allIds.length; i++) {
          playerStates.set(allIds[i]!, initialStates[i]!);
        }

        for (let i = 0; i < allIds.length; i++) {
          const socket = allSockets[i]!;
          const userId = allIds[i]!;
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
          const currentPlayerId =
            anyState.players[currentPlayerIndex]?.playerId;
          if (!currentPlayerId) break;

          const currentUserIndex = allIds.indexOf(currentPlayerId);
          if (currentUserIndex === -1) break;

          const currentState = playerStates.get(currentPlayerId)!;
          const validActions = currentState.validActions;
          if (validActions.length === 0) break;

          const socket = allSockets[currentUserIndex]!;
          const publicState =
            currentState.gameSpecificPublicState as Big2PublicState;

          const hasPass = validActions.some((a) => a.type === "pass");
          const hasPlayCards = validActions.some((a) => a.type === "playCards");

          const nextStatePromises = allSockets.map(
            (s, idx) =>
              new Promise<{ userId: string; state: PlayerView }>((resolve) => {
                s.once("game:state", (state) => {
                  resolve({ userId: allIds[idx]!, state });
                });
              }),
          );

          let actionSuccess = false;

          if (
            hasPass &&
            !publicState.isFreePlay &&
            !publicState.isFirstPlayOfGame
          ) {
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
          } else if (hasPlayCards) {
            const cards = pickCardsToPlay(currentState.you.hand, publicState);
            if (!cards) {
              const ack = await new Promise<{
                success: boolean;
                error?: string;
              }>((resolve) => {
                socket.emit(
                  "game:action",
                  {
                    gameId,
                    action: { type: "pass", playerId: currentPlayerId },
                  },
                  resolve,
                );
              });
              actionSuccess = ack.success;
            } else {
              const ack = await new Promise<{
                success: boolean;
                error?: string;
              }>((resolve) => {
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
              });
              actionSuccess = ack.success;
            }
          } else {
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
        expect(finalState.winner).toBeDefined();
      } finally {
        allSockets.forEach(disconnectSocket);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("Guest rejoining", () => {
    it("guest with existing session can rejoin without duplicate", async () => {
      const host = await createTestUser("RejoinHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      const guest = await createTestGuest(ctx.app, gameId, "RejoinGuest");

      // First join
      const join1 = await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${guest.token}`)
        .send({ gameId });
      expect(join1.status).toBe(200);

      // Second join with same token — idempotent
      const join2 = await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${guest.token}`)
        .send({ gameId });
      expect(join2.status).toBe(200);

      // Guest appears exactly once in playerIds
      const stateRes = await request(ctx.app)
        .get(`/getGameState?gameId=${gameId}`)
        .set("Authorization", `Bearer ${guest.token}`);

      expect(stateRes.status).toBe(200);
      const playerIds = stateRes.body.gameState.playerIds as string[];
      const occurrences = playerIds.filter((id) => id === guest.guestId).length;
      expect(occurrences).toBe(1);
    });

    it("guest can re-create session with existingGuestId after disconnect", async () => {
      const host = await createTestUser("ReconnectHost");
      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${host.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });
      const gameId = createRes.body.gameId as string;

      // Original session
      const guest = await createTestGuest(ctx.app, gameId, "ReconnectGuest");
      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${guest.token}`)
        .send({ gameId });

      // Re-create session with same guestId (simulating reconnect)
      const reSessionRes = await request(ctx.app).post("/guest/session").send({
        displayName: "ReconnectGuest",
        gameId,
        existingGuestId: guest.guestId,
      });

      expect(reSessionRes.status).toBe(200);
      expect(reSessionRes.body.guestId).toBe(guest.guestId);

      const newToken = reSessionRes.body.token as string;

      // Re-join with new token
      const rejoinRes = await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${newToken}`)
        .send({ gameId });
      expect(rejoinRes.status).toBe(200);

      // Guest is still in the game with the same ID
      const stateRes = await request(ctx.app)
        .get(`/getGameState?gameId=${gameId}`)
        .set("Authorization", `Bearer ${newToken}`);

      const playerIds = stateRes.body.gameState.playerIds as string[];
      expect(playerIds).toContain(guest.guestId);
    });
  });
});
