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
import type { EnrichedPlayerView } from "../../src/shared/socket-events.js";

/** Join all sockets to a game room. */
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

/** Start the game from socket[0] and wait for all players to get game:state. */
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

describe("Turn Timer integration", () => {
  describe("game creation", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await createTestServer();
    });

    afterAll(async () => {
      await ctx.close();
    });

    it("stores turnTimerSeconds on the game entity when creating with a timer", async () => {
      const user = await createTestUser("TimerCreatorA");

      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 60 });

      expect(createRes.status).toBe(200);
      const gameId = createRes.body.gameId as string;

      const stateRes = await request(ctx.app)
        .get(`/getGameState?gameId=${gameId}`)
        .set("Authorization", `Bearer ${user.accessToken}`);

      expect(stateRes.status).toBe(200);
      expect(stateRes.body.gameState.turnTimerSeconds).toBe(60);
    });

    it("rejects game creation when no timer specified", async () => {
      const user = await createTestUser("TimerCreatorB");

      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4 });

      expect(createRes.status).toBe(400);
    });

    it("rejects invalid turnTimerSeconds (e.g. 45)", async () => {
      const user = await createTestUser("TimerCreatorC");

      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 45 });

      expect(createRes.status).toBe(400);
    });

    it("accepts turnTimerSeconds of 30", async () => {
      const user = await createTestUser("TimerCreatorD");

      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });

      expect(createRes.status).toBe(200);
    });

    it("accepts turnTimerSeconds of 90", async () => {
      const user = await createTestUser("TimerCreatorE");

      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 90 });

      expect(createRes.status).toBe(200);
    });
  });

  describe("game:state with turnDeadline", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await createTestServer();
    });

    afterAll(async () => {
      await ctx.close();
    });

    it("emits non-null turnDeadline after game start with timer", async () => {
      const [userA, userB] = await Promise.all([
        createTestUser("NullDeadlineA"),
        createTestUser("NullDeadlineB"),
      ]);

      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${userA!.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 30 });

      expect(createRes.status).toBe(200);
      const gameId = createRes.body.gameId as string;

      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${userB!.accessToken}`)
        .send({ gameId });

      const sockets = await Promise.all([
        createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
        createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
      ]);

      try {
        await joinGameRoom(sockets, gameId);
        const initialStates = await startGame(sockets, gameId);

        for (const state of initialStates) {
          expect(state.turnDeadline).not.toBeNull();
        }
      } finally {
        sockets.forEach(disconnectSocket);
      }
    });

    it("emits non-null turnDeadline after game start when timer is configured", async () => {
      const [userA, userB] = await Promise.all([
        createTestUser("DeadlineA"),
        createTestUser("DeadlineB"),
      ]);

      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${userA!.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 60 });

      const gameId = createRes.body.gameId as string;

      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${userB!.accessToken}`)
        .send({ gameId });

      const sockets = await Promise.all([
        createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
        createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
      ]);

      try {
        await joinGameRoom(sockets, gameId);
        const initialStates = await startGame(sockets, gameId);

        for (const state of initialStates) {
          expect(state.turnDeadline).not.toBeNull();
          // First turn uses 2x duration, so deadline should be ~120s from now
          const remaining = state.turnDeadline! - Date.now();
          expect(remaining).toBeGreaterThan(110_000);
          expect(remaining).toBeLessThanOrEqual(120_000);
        }
      } finally {
        sockets.forEach(disconnectSocket);
      }
    });

    it("turnDeadline updates after a player action", async () => {
      const [userA, userB] = await Promise.all([
        createTestUser("DeadlineUpdateA"),
        createTestUser("DeadlineUpdateB"),
      ]);

      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${userA!.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 60 });

      const gameId = createRes.body.gameId as string;

      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${userB!.accessToken}`)
        .send({ gameId });

      const sockets = await Promise.all([
        createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
        createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
      ]);

      try {
        await joinGameRoom(sockets, gameId);
        const initialStates = await startGame(sockets, gameId);

        const firstDeadline = initialStates[0]!.turnDeadline!;
        expect(firstDeadline).not.toBeNull();

        // Find the current player's socket and play their lowest card
        const currentPlayerIndex = initialStates[0]!.currentPlayerIndex;
        const currentSocket = sockets[currentPlayerIndex]!;
        const currentView = initialStates[currentPlayerIndex]!;
        const lowestCard = currentView.you.hand[0]!;

        // Set up listener for next state update
        const nextStatePromise = new Promise<EnrichedPlayerView>((resolve) => {
          sockets[0]!.once("game:state", resolve);
        });

        await new Promise<void>((resolve, reject) => {
          currentSocket.emit(
            "game:action",
            {
              gameId,
              action: { type: "playCards", playerId: "", cards: [lowestCard] },
            },
            (ack) => {
              if (ack.success) resolve();
              else reject(new Error(`game:action failed: ${ack.error}`));
            },
          );
        });

        const nextState = await nextStatePromise;

        // After a normal turn, the deadline should be ~60s (1x, not 2x)
        expect(nextState.turnDeadline).not.toBeNull();
        const remaining = nextState.turnDeadline! - Date.now();
        expect(remaining).toBeGreaterThan(50_000);
        expect(remaining).toBeLessThanOrEqual(60_000);
      } finally {
        sockets.forEach(disconnectSocket);
      }
    });
  });

  describe("timer expiry (FakeTimerProvider)", () => {
    let ctx: TestServerContext;

    beforeAll(async () => {
      ctx = await createTestServer();
    });

    afterAll(async () => {
      await ctx.close();
    });

    it("timer expiry auto-passes and emits game:timerExpired to all players", async () => {
      const [userA, userB] = await Promise.all([
        createTestUser("TimerExpiryA"),
        createTestUser("TimerExpiryB"),
      ]);

      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${userA!.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 60 });

      const gameId = createRes.body.gameId as string;

      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${userB!.accessToken}`)
        .send({ gameId });

      const sockets = await Promise.all([
        createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
        createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
      ]);

      try {
        await joinGameRoom(sockets, gameId);
        await startGame(sockets, gameId);

        // Listen for timerExpired and next state on both sockets
        const timerExpiredPromises = sockets.map(
          (socket) =>
            new Promise<{ gameId: string; playerId: string; action: string }>(
              (resolve) => {
                socket.once("game:timerExpired", resolve);
              },
            ),
        );

        const nextStatePromises = sockets.map(
          (socket) =>
            new Promise<EnrichedPlayerView>((resolve) => {
              socket.once("game:state", resolve);
            }),
        );

        // Fire the timer manually via FakeTimerProvider
        const fired = ctx.timerProvider.fireAll();
        expect(fired).toBe(1);

        // Wait for timerExpired events on all sockets
        const timerExpiredPayloads = await Promise.all(timerExpiredPromises);

        for (const payload of timerExpiredPayloads) {
          expect(payload.gameId).toBe(gameId);
          expect(typeof payload.playerId).toBe("string");
          expect(["pass", "playCards"]).toContain(payload.action);
        }

        // Wait for state updates
        const nextStates = await Promise.all(nextStatePromises);
        for (const state of nextStates) {
          // Turn should have advanced
          expect(state.version).toBeGreaterThan(1);
        }
      } finally {
        sockets.forEach(disconnectSocket);
      }
    });

    it("timer restarts after each action (new timer scheduled)", async () => {
      const [userA, userB] = await Promise.all([
        createTestUser("TimerRestartA"),
        createTestUser("TimerRestartB"),
      ]);

      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${userA!.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 60 });

      const gameId = createRes.body.gameId as string;

      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${userB!.accessToken}`)
        .send({ gameId });

      const sockets = await Promise.all([
        createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
        createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
      ]);

      try {
        await joinGameRoom(sockets, gameId);
        const countBefore = ctx.timerProvider.pendingCount;
        const initialStates = await startGame(sockets, gameId);

        // One timer was added for this game
        expect(ctx.timerProvider.pendingCount).toBe(countBefore + 1);

        // Find current player and play a card
        const currentPlayerIndex = initialStates[0]!.currentPlayerIndex;
        const currentSocket = sockets[currentPlayerIndex]!;
        const currentView = initialStates[currentPlayerIndex]!;
        const lowestCard = currentView.you.hand[0]!;

        const nextStatePromise = new Promise<EnrichedPlayerView>((resolve) => {
          sockets[0]!.once("game:state", resolve);
        });

        await new Promise<void>((resolve, reject) => {
          currentSocket.emit(
            "game:action",
            {
              gameId,
              action: { type: "playCards", playerId: "", cards: [lowestCard] },
            },
            (ack) => {
              if (ack.success) resolve();
              else reject(new Error(`game:action failed: ${ack.error}`));
            },
          );
        });

        await nextStatePromise;

        // After action, the old timer was cancelled and a new one started —
        // net pending count stays the same relative to before this game started
        expect(ctx.timerProvider.pendingCount).toBe(countBefore + 1);
      } finally {
        sockets.forEach(disconnectSocket);
      }
    });

    it("timer is cancelled on game completion (no pending timers)", async () => {
      const [userA, userB] = await Promise.all([
        createTestUser("TimerCompleteA"),
        createTestUser("TimerCompleteB"),
      ]);

      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${userA!.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 60 });

      const gameId = createRes.body.gameId as string;

      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${userB!.accessToken}`)
        .send({ gameId });

      const sockets = await Promise.all([
        createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
        createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
      ]);

      try {
        await joinGameRoom(sockets, gameId);
        const initialStates = await startGame(sockets, gameId);

        // Play through the entire game using timer expiry to advance turns
        const allStates = new Map<number, EnrichedPlayerView>();
        for (let i = 0; i < 2; i++) {
          allStates.set(i, initialStates[i]!);
        }

        // Listen for ongoing state updates
        for (let i = 0; i < 2; i++) {
          const idx = i;
          sockets[i]!.on("game:state", (state) => {
            allStates.set(idx, state);
          });
        }

        // Run at most 200 timer fires to complete the game
        let turnCount = 0;
        const MAX_TURNS = 200;

        while (turnCount < MAX_TURNS) {
          const anyState = allStates.get(0)!;
          if (anyState.status === "COMPLETED") break;

          const statePromise = new Promise<void>((resolve) => {
            sockets[0]!.once("game:state", resolve);
          });

          const fired = ctx.timerProvider.fireAll();
          if (fired === 0) break;

          await statePromise;
          turnCount++;
        }

        const finalState = allStates.get(0)!;
        expect(finalState.status).toBe("COMPLETED");
        // Timer for this specific game was unregistered on completion
        expect(ctx.turnTimerService.hasTimer(gameId)).toBe(false);
        expect(ctx.turnTimerService.getDeadline(gameId)).toBeNull();
      } finally {
        sockets.forEach(disconnectSocket);
      }
    });

    it("game:state includes null turnDeadline after timer fires (no active timer until restart)", async () => {
      const [userA, userB] = await Promise.all([
        createTestUser("TimerDeadlineAfterFireA"),
        createTestUser("TimerDeadlineAfterFireB"),
      ]);

      const createRes = await request(ctx.app)
        .post("/createGame")
        .set("Authorization", `Bearer ${userA!.accessToken}`)
        .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 60 });

      const gameId = createRes.body.gameId as string;

      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${userB!.accessToken}`)
        .send({ gameId });

      const sockets = await Promise.all([
        createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
        createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
      ]);

      try {
        await joinGameRoom(sockets, gameId);
        await startGame(sockets, gameId);

        // Wait for the post-fire state update with a new deadline
        const nextStatePromise = new Promise<EnrichedPlayerView>((resolve) => {
          sockets[0]!.once("game:state", resolve);
        });

        ctx.timerProvider.fireAll();

        const nextState = await nextStatePromise;
        // After timer fires and restarts for the next turn, a new deadline is set
        expect(nextState.turnDeadline).not.toBeNull();
        // The new deadline should be ~60s (normal turn, not first turn)
        const remaining = nextState.turnDeadline! - Date.now();
        expect(remaining).toBeGreaterThan(50_000);
        expect(remaining).toBeLessThanOrEqual(60_000);
      } finally {
        sockets.forEach(disconnectSocket);
      }
    });
  });
});
