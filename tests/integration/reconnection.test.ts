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
 * Create a 2-player game (no turn timer), join, and start it.
 * Returns unique usernames via prefix to avoid collisions across tests.
 */
async function setup2PlayerGame(
  ctx: TestServerContext,
  prefix: string,
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
    .send({ gameType: "big2", maxPlayers: 2 });
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
 * The observer socket must already be listening in the game room.
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

  it("others receive game:playerDisconnected when a player disconnects", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "DisconnectEvent",
    );
    try {
      // socket[0] is userA, socket[1] is userB — disconnect userA, observe from userB
      const disconnectPayload = await disconnectAndWait(
        sockets[0]!,
        sockets[1]!,
      );

      expect(disconnectPayload.playerId).toBe(userA!.id);
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  it("isConnected: false in game:state after player disconnects", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "IsConnectedFalse",
    );
    try {
      const stateAfterDisconnect = new Promise<EnrichedPlayerView>(
        (resolve) => {
          sockets[1]!.once("game:state", resolve);
        },
      );

      sockets[0]!.disconnect();
      const state = await stateAfterDisconnect;

      const disconnectedPlayer = state.players.find(
        (p) => p.playerId === userA!.id,
      );
      expect(disconnectedPlayer?.isConnected).toBe(false);
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  it("grace period timer starts when player disconnects from IN_PROGRESS game", async () => {
    const { sockets, gameId } = await setup2PlayerGame(
      ctx,
      "GracePeriodStarts",
    );
    const countBefore = ctx.timerProvider.pendingCount;
    try {
      await disconnectAndWait(sockets[0]!, sockets[1]!);

      expect(ctx.timerProvider.pendingCount).toBe(countBefore + 1);
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  it("player reconnects within grace period, others receive game:playerReconnected", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "ReconnectEvent",
    );
    try {
      // Disconnect player A
      await disconnectAndWait(sockets[0]!, sockets[1]!);

      // Set up listener for reconnect event on player B
      const reconnectPromise = new Promise<PlayerReconnectedPayload>(
        (resolve) => {
          sockets[1]!.once("game:playerReconnected", resolve);
        },
      );

      // Reconnect player A (new socket with same credentials)
      const newSocketA = await createAuthenticatedSocket(
        ctx.baseUrl,
        userA!.accessToken,
      );
      try {
        await new Promise<void>((resolve, reject) => {
          newSocketA.emit("game:join", { gameId, role: "player" }, (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`game:join failed: ${ack.error}`));
          });
        });

        const payload = await reconnectPromise;
        expect(payload.playerId).toBe(userA!.id);
      } finally {
        disconnectSocket(newSocketA);
      }
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  it("reconnect within grace period cancels the grace period timer", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "GracePeriodCancel",
    );
    try {
      await disconnectAndWait(sockets[0]!, sockets[1]!);
      const countAfterDisconnect = ctx.timerProvider.pendingCount;

      // Reconnect player A
      const newSocketA = await createAuthenticatedSocket(
        ctx.baseUrl,
        userA!.accessToken,
      );
      const reconnectPromise = new Promise<PlayerReconnectedPayload>(
        (resolve) => {
          sockets[1]!.once("game:playerReconnected", resolve);
        },
      );
      await new Promise<void>((resolve, reject) => {
        newSocketA.emit("game:join", { gameId, role: "player" }, (ack) => {
          if (ack.success) resolve();
          else reject(new Error(`game:join failed: ${ack.error}`));
        });
      });
      await reconnectPromise;

      // Grace period timer should have been cancelled
      expect(ctx.timerProvider.pendingCount).toBe(countAfterDisconnect - 1);
      disconnectSocket(newSocketA);
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  it("isConnected: true in game:state after player reconnects", async () => {
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
        userA!.accessToken,
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
          (p) => p.playerId === userA!.id,
        );
        expect(reconnectedPlayer?.isConnected).toBe(true);
      } finally {
        disconnectSocket(newSocketA);
      }
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  it("reconnecting player receives current game state", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "ReconnectState",
    );
    try {
      await disconnectAndWait(sockets[0]!, sockets[1]!);

      const newSocketA = await createAuthenticatedSocket(
        ctx.baseUrl,
        userA!.accessToken,
      );
      try {
        const statePromise = new Promise<EnrichedPlayerView>((resolve) => {
          newSocketA.once("game:state", resolve);
        });

        await new Promise<void>((resolve, reject) => {
          newSocketA.emit("game:join", { gameId, role: "player" }, (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`game:join failed: ${ack.error}`));
          });
        });

        const state = await statePromise;
        expect(state.status).toBe("IN_PROGRESS");
        expect(state.gameId).toBe(gameId);
      } finally {
        disconnectSocket(newSocketA);
      }
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  it("grace period expiry marks player as abandoned", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "GracePeriodExpiry",
    );
    try {
      await disconnectAndWait(sockets[0]!, sockets[1]!);

      expect(ctx.disconnectTimerService.isAbandoned(gameId, userA!.id)).toBe(
        false,
      );

      // Fire the grace period timer
      ctx.timerProvider.fireAll();

      // Small async yield for the callback to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(ctx.disconnectTimerService.isAbandoned(gameId, userA!.id)).toBe(
        true,
      );
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  it("abandoned player is auto-passed immediately when it becomes their turn", async () => {
    // 2-player game with timer so we can control turn advancement
    const [userA, userB] = await Promise.all([
      createTestUser("AutoPassTurnA"),
      createTestUser("AutoPassTurnB"),
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

      // Identify which player has the current turn (player 0 in Big2 starts with 3 of clubs)
      const currentPlayerIdx = initialStates[0]!.currentPlayerIndex;
      const otherIdx = currentPlayerIdx === 0 ? 1 : 0;
      const otherSocket = sockets[otherIdx]!;
      const otherUserId = otherIdx === 0 ? userA!.id : userB!.id;

      // Disconnect the OTHER player (not the current player) to make them abandoned
      const waitForDisconnect = new Promise<void>((resolve) => {
        sockets[currentPlayerIdx]!.once("game:playerDisconnected", () =>
          resolve(),
        );
      });
      sockets[otherIdx]!.disconnect();
      await waitForDisconnect;

      // The grace period timer was just scheduled — capture its ID before firing
      const gracePeriodTimerId = ctx.timerProvider.lastScheduledId!;

      // Fire only the grace period timer — leaves the turn timer still pending
      ctx.timerProvider.fire(gracePeriodTimerId);
      await new Promise((r) => setTimeout(r, 50));
      expect(ctx.disconnectTimerService.isAbandoned(gameId, otherUserId)).toBe(
        true,
      );

      // Now the current player acts — this should advance to the abandoned player's
      // turn, which should be immediately auto-passed
      const versionBefore = initialStates[0]!.version;

      const stateAfterAutoPass = new Promise<EnrichedPlayerView>((resolve) => {
        sockets[currentPlayerIdx]!.on("game:state", (state) => {
          // Wait for a state where the turn has advanced past the abandoned player
          if (state.version > versionBefore + 1) {
            resolve(state);
          }
        });
      });

      // Fire the turn timer — auto-passes current player's turn, then auto-pass chain
      // should also immediately pass the abandoned other player
      ctx.timerProvider.fireAll();

      const finalState = await stateAfterAutoPass;
      // Version should have advanced by at least 2 (current player + abandoned player)
      expect(finalState.version).toBeGreaterThan(versionBefore + 1);
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("grace period expiry with player whose turn it is triggers immediate auto-pass", async () => {
    const [userA, userB] = await Promise.all([
      createTestUser("GraceExpireTurnA"),
      createTestUser("GraceExpireTurnB"),
    ]);

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${userA!.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 2 });
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

      // Find the current player and disconnect them
      const currentPlayerIdx = initialStates[0]!.currentPlayerIndex;
      const otherIdx = 1 - currentPlayerIdx;
      const currentUserId = currentPlayerIdx === 0 ? userA!.id : userB!.id;

      const waitForDisconnect = new Promise<void>((resolve) => {
        sockets[otherIdx]!.once("game:playerDisconnected", () => resolve());
      });
      sockets[currentPlayerIdx]!.disconnect();
      await waitForDisconnect;

      // Set up listener for a state update from the other socket
      const stateAfterAutoPass = new Promise<EnrichedPlayerView>((resolve) => {
        sockets[otherIdx]!.once("game:state", resolve);
      });

      // Fire grace period — it's currently the disconnected player's turn
      ctx.timerProvider.fireAll();
      await new Promise((r) => setTimeout(r, 50));

      // Player should be abandoned and auto-pass should have fired
      expect(
        ctx.disconnectTimerService.isAbandoned(gameId, currentUserId),
      ).toBe(true);

      const state = await stateAfterAutoPass;
      // Turn should have advanced past the abandoned player
      expect(state.version).toBeGreaterThan(initialStates[0]!.version);
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("reconnect after abandonment clears abandoned status", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "ReconnectClearsAbandoned",
    );
    try {
      await disconnectAndWait(sockets[0]!, sockets[1]!);

      // Fire grace period to mark as abandoned
      ctx.timerProvider.fireAll();
      await new Promise((r) => setTimeout(r, 50));
      expect(ctx.disconnectTimerService.isAbandoned(gameId, userA!.id)).toBe(
        true,
      );

      // Reconnect
      const reconnectEventPromise = new Promise<PlayerReconnectedPayload>(
        (resolve) => {
          sockets[1]!.once("game:playerReconnected", resolve);
        },
      );
      const newSocketA = await createAuthenticatedSocket(
        ctx.baseUrl,
        userA!.accessToken,
      );
      try {
        await new Promise<void>((resolve, reject) => {
          newSocketA.emit("game:join", { gameId, role: "player" }, (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`game:join failed: ${ack.error}`));
          });
        });
        await reconnectEventPromise;

        expect(ctx.disconnectTimerService.isAbandoned(gameId, userA!.id)).toBe(
          false,
        );
      } finally {
        disconnectSocket(newSocketA);
      }
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  it("no grace period timer started for CREATED (lobby) game disconnect", async () => {
    const [userA, userB] = await Promise.all([
      createTestUser("LobbyDisconnectA"),
      createTestUser("LobbyDisconnectB"),
    ]);

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${userA!.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 2 });
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

    const countBefore = ctx.timerProvider.pendingCount;

    // Disconnect player A
    const playerLeftPromise = new Promise<void>((resolve) => {
      sockets[1]!.once("lobby:playerLeft", () => resolve());
    });
    sockets[0]!.disconnect();
    await playerLeftPromise;

    // No grace period timer should have been added
    expect(ctx.timerProvider.pendingCount).toBe(countBefore);

    disconnectSocket(sockets[1]!);
  });

  it("multiple tabs: one tab disconnects, player stays connected (no grace period)", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "MultipleTabs",
    );
    try {
      // Connect a second socket for player A (simulating another tab)
      const secondSocketA = await createAuthenticatedSocket(
        ctx.baseUrl,
        userA!.accessToken,
      );
      await new Promise<void>((resolve, reject) => {
        secondSocketA.emit("game:join", { gameId, role: "player" }, (ack) => {
          if (ack.success) resolve();
          else reject(new Error(`second tab game:join failed: ${ack.error}`));
        });
      });

      const countBefore = ctx.timerProvider.pendingCount;

      // Disconnect the first socket — second socket still active for same player
      // No game:playerDisconnected should fire; no grace period should start
      sockets[0]!.disconnect();

      // Small delay to let the server process the disconnect
      await new Promise((r) => setTimeout(r, 100));

      // Grace period count should not have increased
      expect(ctx.timerProvider.pendingCount).toBe(countBefore);

      disconnectSocket(secondSocketA);
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });

  it("game with no turn timer, abandoned player is still auto-passed on their turn", async () => {
    const [userA, userB] = await Promise.all([
      createTestUser("NoTimerAbandonA"),
      createTestUser("NoTimerAbandonB"),
    ]);

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${userA!.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 2 });
    // No turnTimerSeconds — null timer
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

      // Disconnect the non-current player and mark them abandoned
      const currentPlayerIdx = initialStates[0]!.currentPlayerIndex;
      const otherIdx = 1 - currentPlayerIdx;
      const otherUserId = otherIdx === 0 ? userA!.id : userB!.id;

      const waitForDisconnect = new Promise<void>((resolve) => {
        sockets[currentPlayerIdx]!.once("game:playerDisconnected", () =>
          resolve(),
        );
      });
      sockets[otherIdx]!.disconnect();
      await waitForDisconnect;

      // Fire grace period — mark other player as abandoned
      ctx.timerProvider.fireAll();
      await new Promise((r) => setTimeout(r, 50));
      expect(ctx.disconnectTimerService.isAbandoned(gameId, otherUserId)).toBe(
        true,
      );

      // Current player plays their lowest card — this will advance to the
      // abandoned player's turn, which should be immediately auto-passed back
      const currentSocket = sockets[currentPlayerIdx]!;
      const currentView = initialStates[currentPlayerIdx]!;
      const lowestCard = currentView.you.hand[0]!;

      // Listen for at least 2 state updates (current player's action + abandoned auto-pass)
      const versionBefore = initialStates[0]!.version;
      const stateAfterAutoPass = new Promise<EnrichedPlayerView>((resolve) => {
        sockets[currentPlayerIdx]!.on("game:state", (state) => {
          // Version advances once for current player's action, once more for auto-pass
          if (state.version > versionBefore + 1) {
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

      const finalState = await stateAfterAutoPass;
      expect(finalState.version).toBeGreaterThan(versionBefore + 1);
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("player disconnect and rapid reconnect restarts grace period on second disconnect", async () => {
    const { userA, sockets, gameId } = await setup2PlayerGame(
      ctx,
      "FlappingPlayer",
    );
    try {
      // First disconnect
      await disconnectAndWait(sockets[0]!, sockets[1]!);
      const countAfterFirstDisconnect = ctx.timerProvider.pendingCount;
      expect(countAfterFirstDisconnect).toBeGreaterThan(0);

      // Reconnect before grace period fires
      const reconnectEventPromise = new Promise<PlayerReconnectedPayload>(
        (resolve) => {
          sockets[1]!.once("game:playerReconnected", resolve);
        },
      );
      const newSocketA = await createAuthenticatedSocket(
        ctx.baseUrl,
        userA!.accessToken,
      );
      await new Promise<void>((resolve, reject) => {
        newSocketA.emit("game:join", { gameId, role: "player" }, (ack) => {
          if (ack.success) resolve();
          else reject(new Error(`game:join failed: ${ack.error}`));
        });
      });
      await reconnectEventPromise;

      // Grace period should have been cancelled
      expect(ctx.timerProvider.pendingCount).toBe(
        countAfterFirstDisconnect - 1,
      );

      // Second disconnect — a new grace period should start
      const secondDisconnectPromise = new Promise<PlayerDisconnectedPayload>(
        (resolve) => {
          sockets[1]!.once("game:playerDisconnected", resolve);
        },
      );
      newSocketA.disconnect();
      await secondDisconnectPromise;

      // New grace period timer should be active
      expect(ctx.timerProvider.pendingCount).toBeGreaterThanOrEqual(1);
    } finally {
      disconnectSocket(sockets[1]!);
    }
  });
});
