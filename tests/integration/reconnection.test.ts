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
  PlayerDisconnectedPayload,
  PlayerReconnectedPayload,
} from "../../src/shared/socket-events.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

/**
 * Create a 2-player game with a turn timer, join, and start it.
 */
async function setup2PlayerGame(
  ctx: TestServerContext,
  prefix: string,
  turnTimerSeconds: 30 | 60 | 90 = 60,
): Promise<{
  userA: { accessToken: string; id: string };
  userB: { accessToken: string; id: string };
  gameId: string;
  sockets: [TypedClientSocket, TypedClientSocket];
  initialStates: [EnrichedPlayerView, EnrichedPlayerView];
}> {
  const [userA, userB] = await Promise.all([
    createTestUser(`${prefix}A`),
    createTestUser(`${prefix}B`),
  ]);

  const createRes = await request(ctx.app)
    .post("/createGame")
    .set("Authorization", `Bearer ${userA!.accessToken}`)
    .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds });
  expect(createRes.status).toBe(200);

  const gameId = createRes.body.gameId as string;

  await request(ctx.app)
    .post("/joinGame")
    .set("Authorization", `Bearer ${userB!.accessToken}`)
    .send({ gameId });

  const sockets = (await Promise.all([
    createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
    createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
  ])) as [TypedClientSocket, TypedClientSocket];

  await joinGameRoom(sockets, gameId);
  const initialStates = (await startGame(sockets, gameId)) as [
    EnrichedPlayerView,
    EnrichedPlayerView,
  ];

  return { userA: userA!, userB: userB!, gameId, sockets, initialStates };
}

/**
 * Disconnect a socket and wait for the server to emit game:playerDisconnected.
 */
function disconnectAndWait(
  socketToDisconnect: TypedClientSocket,
  observerSocket: TypedClientSocket,
): Promise<PlayerDisconnectedPayload> {
  return new Promise<PlayerDisconnectedPayload>((resolve) => {
    observerSocket.once("game:playerDisconnected", resolve);
    socketToDisconnect.disconnect();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reconnection and disconnect handling", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  // Test 1
  it("disconnect emits game:playerDisconnected to others", async () => {
    const { userA, sockets } = await setup2PlayerGame(ctx, "DisconnectEvent");
    try {
      const payload = await disconnectAndWait(sockets[0]!, sockets[1]!);
      expect(payload.playerId).toBe(userA.id);
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  // Test 2
  it("disconnect shows isConnected: false in game:state broadcast", async () => {
    const { userA, sockets } = await setup2PlayerGame(ctx, "IsConnectedFalse");
    try {
      const stateAfterDisconnect = new Promise<EnrichedPlayerView>(
        (resolve) => {
          sockets[1]!.once("game:state", resolve);
        },
      );

      sockets[0]!.disconnect();
      const state = await stateAfterDisconnect;

      const disconnectedPlayer = state.players.find(
        (p) => p.playerId === userA.id,
      );
      expect(disconnectedPlayer?.isConnected).toBe(false);
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  // Test 3
  it("reconnect emits game:playerReconnected to others", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "ReconnectEvent",
    );
    try {
      await disconnectAndWait(sockets[0]!, sockets[1]!);

      const reconnectPromise = new Promise<PlayerReconnectedPayload>(
        (resolve) => {
          sockets[1]!.once("game:playerReconnected", resolve);
        },
      );

      const newSocketA = await createAuthenticatedSocket(
        ctx.baseUrl,
        userA.accessToken,
      );
      try {
        await new Promise<void>((resolve, reject) => {
          newSocketA.emit("game:join", { gameId, role: "player" }, (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`game:join failed: ${ack.error}`));
          });
        });

        const payload = await reconnectPromise;
        expect(payload.playerId).toBe(userA.id);
      } finally {
        disconnectSocket(newSocketA);
      }
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  // Test 4
  it("reconnect shows isConnected: true in game:state broadcast", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "IsConnectedTrue",
    );
    try {
      await disconnectAndWait(sockets[0]!, sockets[1]!);

      const stateAfterReconnect = new Promise<EnrichedPlayerView>((resolve) => {
        sockets[1]!.once("game:state", resolve);
      });

      const newSocketA = await createAuthenticatedSocket(
        ctx.baseUrl,
        userA.accessToken,
      );
      try {
        await new Promise<void>((resolve, reject) => {
          newSocketA.emit("game:join", { gameId, role: "player" }, (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`game:join failed: ${ack.error}`));
          });
        });

        const state = await stateAfterReconnect;
        const reconnectedPlayer = state.players.find(
          (p) => p.playerId === userA.id,
        );
        expect(reconnectedPlayer?.isConnected).toBe(true);
      } finally {
        disconnectSocket(newSocketA);
      }
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  // Test 5
  it("turn timer expiry while disconnected marks player as abandoned", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "TimerExpiryAbandoned",
    );
    try {
      await disconnectAndWait(sockets[0]!, sockets[1]!);

      expect(ctx.connectionManager.isAbandoned(gameId, userA.id)).toBe(false);

      // Fire timer and wait for the state broadcast to confirm processing completed
      const waitForState = () =>
        new Promise<void>((resolve) => {
          sockets[1]!.once("game:state", () => resolve());
        });

      // Fire all timers — the turn timer for the current player will expire.
      // Wait for game:state broadcast to confirm the async handler completed.
      let statePromise = waitForState();
      ctx.timerProvider.fireAll();
      await statePromise;

      // Fire again in case userA was not first-turn player
      if (!ctx.connectionManager.isAbandoned(gameId, userA.id)) {
        statePromise = waitForState();
        ctx.timerProvider.fireAll();
        await statePromise;
      }

      expect(ctx.connectionManager.isAbandoned(gameId, userA.id)).toBe(true);
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  // Test 6
  it("abandoned player is auto-passed immediately when their turn arrives", async () => {
    const { sockets, gameId, initialStates } = await setup2PlayerGame(
      ctx,
      "AutoPassAbandoned",
    );
    try {
      const currentPlayerIdx = initialStates[0]!.currentPlayerIndex;
      const otherIdx = 1 - currentPlayerIdx;

      await disconnectAndWait(sockets[otherIdx]!, sockets[currentPlayerIdx]!);

      const versionBefore = initialStates[0]!.version;

      // Fire turn timer for current player — advances turn to disconnected player.
      // Wait for state broadcast confirming the timer expiry was processed.
      let statePromise = new Promise<EnrichedPlayerView>((resolve) => {
        sockets[currentPlayerIdx]!.once("game:state", resolve);
      });
      ctx.timerProvider.fireAll();
      await statePromise;

      // Fire again — disconnected player's timer expires, marks abandoned, turn advances back.
      // The second fire + autoPlayAbandoned should produce version > versionBefore + 1.
      const finalStatePromise = new Promise<EnrichedPlayerView>((resolve) => {
        sockets[currentPlayerIdx]!.on("game:state", (state) => {
          if (state.version > versionBefore + 1) {
            resolve(state);
          }
        });
      });
      ctx.timerProvider.fireAll();
      const finalState = await finalStatePromise;

      expect(finalState.version).toBeGreaterThan(versionBefore + 1);
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  // Test 7
  it("reconnect after abandonment clears abandoned status", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "ReconnectClearsAbandoned",
    );
    try {
      await disconnectAndWait(sockets[0]!, sockets[1]!);

      // Fire timers until userA is marked abandoned — wait for state broadcasts
      let statePromise = new Promise<void>((resolve) => {
        sockets[1]!.once("game:state", () => resolve());
      });
      ctx.timerProvider.fireAll();
      await statePromise;

      if (!ctx.connectionManager.isAbandoned(gameId, userA.id)) {
        statePromise = new Promise<void>((resolve) => {
          sockets[1]!.once("game:state", () => resolve());
        });
        ctx.timerProvider.fireAll();
        await statePromise;
      }

      expect(ctx.connectionManager.isAbandoned(gameId, userA.id)).toBe(true);

      // Reconnect
      const reconnectEventPromise = new Promise<PlayerReconnectedPayload>(
        (resolve) => {
          sockets[1]!.once("game:playerReconnected", resolve);
        },
      );
      const newSocketA = await createAuthenticatedSocket(
        ctx.baseUrl,
        userA.accessToken,
      );
      try {
        await new Promise<void>((resolve, reject) => {
          newSocketA.emit("game:join", { gameId, role: "player" }, (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`game:join failed: ${ack.error}`));
          });
        });
        await reconnectEventPromise;

        expect(ctx.connectionManager.isAbandoned(gameId, userA.id)).toBe(false);
      } finally {
        disconnectSocket(newSocketA);
      }
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  // Test 8
  it("multiple abandoned players are chained — both skipped in sequence", async () => {
    // 4-player game: abandon players B and C, player A acts — should skip both B and C
    const [userA, userB, userC, userD] = await Promise.all([
      createTestUser("MultiAbandonA"),
      createTestUser("MultiAbandonB"),
      createTestUser("MultiAbandonC"),
      createTestUser("MultiAbandonD"),
    ]);

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${userA!.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 60 });
    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    for (const user of [userB, userC, userD]) {
      await request(ctx.app)
        .post("/joinGame")
        .set("Authorization", `Bearer ${user!.accessToken}`)
        .send({ gameId });
    }

    const sockets = await Promise.all([
      createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
      createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
      createAuthenticatedSocket(ctx.baseUrl, userC!.accessToken),
      createAuthenticatedSocket(ctx.baseUrl, userD!.accessToken),
    ]);

    try {
      await joinGameRoom(sockets, gameId);
      const initialStates = await startGame(sockets, gameId);

      const currentPlayerIdx = initialStates[0]!.currentPlayerIndex;
      const currentSocket = sockets[currentPlayerIdx]!;
      const currentView = initialStates[currentPlayerIdx]!;

      // Mark the next two players in turn order as abandoned
      const playerIds = initialStates[0]!.players.map((p) => p.playerId);
      const numPlayers = playerIds.length;
      const nextIdx1 = (currentPlayerIdx + 1) % numPlayers;
      const nextIdx2 = (currentPlayerIdx + 2) % numPlayers;
      ctx.connectionManager.markAbandoned(gameId, playerIds[nextIdx1]!);
      ctx.connectionManager.markAbandoned(gameId, playerIds[nextIdx2]!);

      // Play the lowest card — should advance to abandoned player, auto-pass, advance again
      const versionBefore = initialStates[0]!.version;
      const lowestCard = currentView.you.hand[0]!;

      const stateWithAdvance = new Promise<EnrichedPlayerView>((resolve) => {
        currentSocket.on("game:state", (state) => {
          // Version needs to advance at least 3 (current + 2 abandoned auto-passes)
          if (state.version >= versionBefore + 3) {
            resolve(state);
          }
        });
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

      const finalState = await stateWithAdvance;
      expect(finalState.version).toBeGreaterThanOrEqual(versionBefore + 3);
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  // Test 9
  it("lobby disconnect emits lobby:playerLeft only (no abandonment)", async () => {
    const [userA, userB] = await Promise.all([
      createTestUser("LobbyDisconnectA"),
      createTestUser("LobbyDisconnectB"),
    ]);

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${userA!.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 30 });
    const gameId = createRes.body.gameId as string;

    await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${userB!.accessToken}`)
      .send({ gameId });

    const sockets = await Promise.all([
      createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
      createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
    ]);

    await joinGameRoom(sockets, gameId);
    // Game NOT started — still in CREATED state

    const playerLeftPromise = new Promise<void>((resolve) => {
      sockets[1]!.once("lobby:playerLeft", () => resolve());
    });
    sockets[0]!.disconnect();
    await playerLeftPromise;

    // No abandonment should have been set
    expect(ctx.connectionManager.isAbandoned(gameId, userA!.id)).toBe(false);

    disconnectSocket(sockets[1]!);
  });

  // Test 10
  it("multiple tabs: closing one tab does not trigger disconnect when other tab remains", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "MultipleTabs",
    );
    try {
      // Open a second socket for player A (simulating another tab)
      const secondSocketA = await createAuthenticatedSocket(
        ctx.baseUrl,
        userA.accessToken,
      );
      await new Promise<void>((resolve, reject) => {
        secondSocketA.emit("game:join", { gameId, role: "player" }, (ack) => {
          if (ack.success) resolve();
          else reject(new Error(`second tab game:join failed: ${ack.error}`));
        });
      });

      // Track whether game:playerDisconnected fires
      let disconnectFired = false;
      sockets[1]!.on("game:playerDisconnected", () => {
        disconnectFired = true;
      });

      // Close the first socket — second socket still active for same player
      sockets[0]!.disconnect();

      // Give the server time to process the disconnect
      await new Promise((r) => setTimeout(r, 150));

      // No disconnect event should have fired — player still has second socket
      expect(disconnectFired).toBe(false);
      expect(ctx.connectionManager.isAbandoned(gameId, userA.id)).toBe(false);

      disconnectSocket(secondSocketA);
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  // Test 11
  it("game requires turn timer — null turnTimerSeconds is rejected with 400", async () => {
    const user = await createTestUser("RequireTimerUser");

    const res = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: null });

    expect(res.status).toBe(400);
  });

  // Test 12
  it("game completes during auto-pass chain — timers cleaned, final state broadcast", async () => {
    // This test verifies that if a game completes while auto-passing abandoned players,
    // the turn timer is unregistered and abandoned state is cleared.
    const { sockets, gameId, initialStates } = await setup2PlayerGame(
      ctx,
      "GameCompleteAutoPass",
    );
    try {
      const currentPlayerIdx = initialStates[0]!.currentPlayerIndex;

      // Play through entire game by firing timers repeatedly
      const allStates = new Map<number, EnrichedPlayerView>();
      for (let i = 0; i < 2; i++) {
        allStates.set(i, initialStates[i]!);
      }

      for (let i = 0; i < 2; i++) {
        sockets[i]!.on("game:state", (state) => {
          allStates.set(i, state);
        });
      }

      let turnCount = 0;
      const MAX_TURNS = 200;
      while (turnCount < MAX_TURNS) {
        const currentState = allStates.get(currentPlayerIdx)!;
        if (currentState.status === "COMPLETED") break;

        const statePromise = new Promise<void>((resolve) => {
          sockets[currentPlayerIdx]!.once("game:state", () => resolve());
        });

        const fired = ctx.timerProvider.fireAll();
        if (fired === 0) break;

        await statePromise;
        turnCount++;
      }

      const finalState = allStates.get(currentPlayerIdx)!;
      expect(finalState.status).toBe("COMPLETED");

      // Turn timer should be unregistered after game completion
      expect(ctx.turnTimerService.hasTimer(gameId)).toBe(false);
      expect(ctx.turnTimerService.getDeadline(gameId)).toBeNull();

      // Abandoned state should be cleared
      for (const player of finalState.players) {
        expect(ctx.connectionManager.isAbandoned(gameId, player.playerId)).toBe(
          false,
        );
      }
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  // Test 13
  it("disconnect from COMPLETED game does not trigger abandonment", async () => {
    const { sockets, gameId, initialStates } = await setup2PlayerGame(
      ctx,
      "CompletedDisconnect",
    );
    try {
      const currentPlayerIdx = initialStates[0]!.currentPlayerIndex;

      // Play game to completion via timers
      for (let i = 0; i < 2; i++) {
        sockets[i]!.on("game:state", () => {});
      }

      let turnCount = 0;
      const MAX_TURNS = 200;
      while (turnCount < MAX_TURNS) {
        const statePromise = new Promise<EnrichedPlayerView>((resolve) => {
          sockets[currentPlayerIdx]!.once("game:state", (s) => resolve(s));
        });
        const fired = ctx.timerProvider.fireAll();
        if (fired === 0) break;
        const state = await statePromise;
        if (state.status === "COMPLETED") break;
        turnCount++;
      }

      // Game is now COMPLETED — disconnect a player
      const playerIds = initialStates[0]!.players.map((p) => p.playerId);
      sockets[0]!.disconnect();
      await new Promise((r) => setTimeout(r, 50));

      // No abandonment should be triggered for a completed game
      expect(ctx.connectionManager.isAbandoned(gameId, playerIds[0]!)).toBe(
        false,
      );
      expect(ctx.connectionManager.isAbandoned(gameId, playerIds[1]!)).toBe(
        false,
      );
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });
});
