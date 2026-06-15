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
  SpectatorCountPayload,
} from "../../src/shared/socket-events.js";
import type { Card } from "../../src/shared/engine-types.js";
import type { Big2PublicState } from "../../src/shared/big2-types.js";

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

/** Join all player sockets to their game room. */
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

/** Start the game from sockets[0] and wait for all players to receive game:state. */
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
 * Join a spectator socket to a game and wait for the initial game:spectatorState.
 * Registers the listener BEFORE emitting join to avoid missing the event.
 */
async function joinAsSpectator(
  spectatorSocket: TypedClientSocket,
  gameId: string,
): Promise<EnrichedSpectatorView> {
  const statePromise = new Promise<EnrichedSpectatorView>((resolve) => {
    spectatorSocket.once("game:spectatorState", resolve);
  });

  await new Promise<void>((resolve, reject) => {
    spectatorSocket.emit("game:join", { gameId, role: "spectator" }, (ack) => {
      if (ack.success) resolve();
      else reject(new Error(`spectator join failed: ${ack.error}`));
    });
  });

  return statePromise;
}

/**
 * Set up a 2-player game, join the game room, and start it.
 * Returns the two player sockets and the gameId.
 */
async function setupInProgressGame(ctx: TestServerContext): Promise<{
  sockets: TypedClientSocket[];
  gameId: string;
  initialStates: EnrichedPlayerView[];
}> {
  const [userA, userB] = await Promise.all([
    createTestUser("SpectatorSetupA"),
    createTestUser("SpectatorSetupB"),
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
  const initialStates = await startGame(sockets, gameId);

  return { sockets, gameId, initialStates };
}

/**
 * Play through a 2-player Big2 game to completion.
 * Returns the final state from socket[0]'s perspective.
 */
async function playGameToCompletion(
  sockets: TypedClientSocket[],
  gameId: string,
  initialStates: EnrichedPlayerView[],
): Promise<EnrichedPlayerView> {
  // Track the latest state for each player (by socket index)
  const latestStates: EnrichedPlayerView[] = [
    initialStates[0]!,
    initialStates[1]!,
  ];

  for (let i = 0; i < 2; i++) {
    const idx = i;
    sockets[i]!.on("game:state", (state) => {
      latestStates[idx] = state;
    });
  }

  const MAX_TURNS = 200;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Use socket[0]'s view to get current game status and current player
    const viewFromSocket0 = latestStates[0]!;
    if (viewFromSocket0.status === "COMPLETED") break;

    const currentPlayerIndex = viewFromSocket0.currentPlayerIndex;
    const currentSocket = sockets[currentPlayerIndex]!;
    // Use the current player's own state (has their hand)
    const currentView = latestStates[currentPlayerIndex]!;
    const validActions = currentView.validActions;
    if (validActions.length === 0) break;

    const publicState = currentView.gameSpecificPublicState as Big2PublicState;
    const hasPass = validActions.some((a) => a.type === "pass");
    const hasPlay = validActions.some((a) => a.type === "playCards");

    // Set up once-listener on BOTH sockets before the action so we capture updates
    const nextStatesPromise = Promise.all(
      sockets.map(
        (s) =>
          new Promise<EnrichedPlayerView>((resolve) => {
            s.once("game:state", resolve);
          }),
      ),
    );

    if (hasPlay && (publicState.isFreePlay || publicState.isFirstPlayOfGame)) {
      // Free play: play lowest card
      const sorted = [...currentView.you.hand].sort(
        (a, b) => cardValue(a) - cardValue(b),
      );
      await new Promise<void>((resolve, reject) => {
        currentSocket.emit(
          "game:action",
          {
            gameId,
            action: { type: "playCards", playerId: "", cards: [sorted[0]!] },
          },
          (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`action failed: ${ack.error}`));
          },
        );
      });
    } else if (hasPass) {
      await new Promise<void>((resolve, reject) => {
        currentSocket.emit(
          "game:action",
          { gameId, action: { type: "pass", playerId: "" } },
          (ack) => {
            if (ack.success) resolve();
            else reject(new Error(`action failed: ${ack.error}`));
          },
        );
      });
    } else if (hasPlay) {
      // Must beat last play — try cards in descending value
      const sorted = [...currentView.you.hand].sort(
        (a, b) => cardValue(b) - cardValue(a),
      );
      let played = false;
      for (const card of sorted) {
        const ack = await new Promise<{ success: boolean; error?: string }>(
          (resolve) => {
            currentSocket.emit(
              "game:action",
              {
                gameId,
                action: { type: "playCards", playerId: "", cards: [card] },
              },
              resolve,
            );
          },
        );
        if (ack.success) {
          played = true;
          break;
        }
      }
      if (!played) break;
    } else {
      break;
    }

    // Wait for both players' states to be updated
    const [s0, s1] = await nextStatesPromise;
    latestStates[0] = s0!;
    latestStates[1] = s1!;
  }

  return latestStates[0]!;
}

describe("Spectating integration", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("spectator joins IN_PROGRESS game and receives game:spectatorState", async () => {
    const { sockets, gameId } = await setupInProgressGame(ctx);
    const spectatorUser = await createTestUser("SpectatorJoinA");
    const spectatorSocket = await createAuthenticatedSocket(
      ctx.baseUrl,
      spectatorUser.accessToken,
    );

    try {
      const spectatorState = await joinAsSpectator(spectatorSocket, gameId);
      expect(spectatorState.gameId).toBe(gameId);
      expect(spectatorState.status).toBe("IN_PROGRESS");
      expect(spectatorState.players.length).toBe(2);
      expect(spectatorState.spectatorCount).toBe(1);
    } finally {
      sockets.forEach(disconnectSocket);
      disconnectSocket(spectatorSocket);
    }
  });

  it("spectator receives game:spectatorState when a player takes an action", async () => {
    const { sockets, gameId, initialStates } = await setupInProgressGame(ctx);
    const spectatorUser = await createTestUser("SpectatorActionA");
    const spectatorSocket = await createAuthenticatedSocket(
      ctx.baseUrl,
      spectatorUser.accessToken,
    );

    try {
      await joinAsSpectator(spectatorSocket, gameId);

      // Set up listener for next spectatorState BEFORE triggering the action
      const nextSpectatorStatePromise = new Promise<EnrichedSpectatorView>(
        (resolve) => {
          spectatorSocket.once("game:spectatorState", resolve);
        },
      );

      // Play the lowest card from the current player (first play is always free)
      const currentPlayerIndex = initialStates[0]!.currentPlayerIndex;
      const currentSocket = sockets[currentPlayerIndex]!;
      const currentView = initialStates[currentPlayerIndex]!;
      const lowestCard = [...currentView.you.hand].sort(
        (a, b) => cardValue(a) - cardValue(b),
      )[0]!;

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

      const nextSpectatorState = await nextSpectatorStatePromise;
      expect(nextSpectatorState.status).toBe("IN_PROGRESS");
      expect(nextSpectatorState.version).toBeGreaterThan(1);
    } finally {
      sockets.forEach(disconnectSocket);
      disconnectSocket(spectatorSocket);
    }
  });

  it("spectator receives turnDeadline in spectator state when game has a timer", async () => {
    const [userA, userB] = await Promise.all([
      createTestUser("SpectatorTimerA"),
      createTestUser("SpectatorTimerB"),
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

    const playerSockets = await Promise.all([
      createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
      createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
    ]);

    const spectatorUser = await createTestUser("SpectatorTimerSpec");
    const spectatorSocket = await createAuthenticatedSocket(
      ctx.baseUrl,
      spectatorUser.accessToken,
    );

    try {
      await joinGameRoom(playerSockets, gameId);
      await startGame(playerSockets, gameId);

      const spectatorState = await joinAsSpectator(spectatorSocket, gameId);
      expect(spectatorState.turnDeadline).not.toBeNull();
    } finally {
      playerSockets.forEach(disconnectSocket);
      disconnectSocket(spectatorSocket);
    }
  });

  it("players receive game:spectatorCount when a spectator joins", async () => {
    const { sockets, gameId } = await setupInProgressGame(ctx);
    const spectatorUser = await createTestUser("SpectatorCountJoinA");
    const spectatorSocket = await createAuthenticatedSocket(
      ctx.baseUrl,
      spectatorUser.accessToken,
    );

    try {
      const countPromise = new Promise<SpectatorCountPayload>((resolve) => {
        sockets[0]!.once("game:spectatorCount", resolve);
      });

      await joinAsSpectator(spectatorSocket, gameId);

      const countPayload = await countPromise;
      expect(countPayload.gameId).toBe(gameId);
      expect(countPayload.count).toBe(1);
    } finally {
      sockets.forEach(disconnectSocket);
      disconnectSocket(spectatorSocket);
    }
  });

  it("players receive game:spectatorCount when a spectator disconnects", async () => {
    const { sockets, gameId } = await setupInProgressGame(ctx);
    const spectatorUser = await createTestUser("SpectatorCountDisconnectA");
    const spectatorSocket = await createAuthenticatedSocket(
      ctx.baseUrl,
      spectatorUser.accessToken,
    );

    try {
      // Join and wait for the join count event
      const joinCountPromise = new Promise<SpectatorCountPayload>((resolve) => {
        sockets[0]!.once("game:spectatorCount", resolve);
      });

      await joinAsSpectator(spectatorSocket, gameId);
      await joinCountPromise;

      // Now listen for the disconnect count, then disconnect the spectator
      const disconnectCountPromise = new Promise<SpectatorCountPayload>(
        (resolve) => {
          sockets[0]!.once("game:spectatorCount", resolve);
        },
      );

      disconnectSocket(spectatorSocket);

      const disconnectPayload = await disconnectCountPromise;
      expect(disconnectPayload.gameId).toBe(gameId);
      expect(disconnectPayload.count).toBe(0);
    } finally {
      sockets.forEach(disconnectSocket);
    }
  });

  it("spectator cannot emit game:action (rejected with SPECTATOR_CANNOT_ACT)", async () => {
    const { sockets, gameId } = await setupInProgressGame(ctx);
    const spectatorUser = await createTestUser("SpectatorActionGuardA");
    const spectatorSocket = await createAuthenticatedSocket(
      ctx.baseUrl,
      spectatorUser.accessToken,
    );

    try {
      await joinAsSpectator(spectatorSocket, gameId);

      const ack = await new Promise<{ success: boolean; error?: string }>(
        (resolve) => {
          spectatorSocket.emit(
            "game:action",
            { gameId, action: { type: "pass", playerId: "" } },
            resolve,
          );
        },
      );

      expect(ack.success).toBe(false);
      expect(ack.error).toBe("SPECTATOR_CANNOT_ACT");
    } finally {
      sockets.forEach(disconnectSocket);
      disconnectSocket(spectatorSocket);
    }
  });

  it("spectator cannot emit game:start (rejected with SPECTATOR_CANNOT_ACT)", async () => {
    const { sockets, gameId } = await setupInProgressGame(ctx);
    const spectatorUser = await createTestUser("SpectatorStartGuardA");
    const spectatorSocket = await createAuthenticatedSocket(
      ctx.baseUrl,
      spectatorUser.accessToken,
    );

    try {
      await joinAsSpectator(spectatorSocket, gameId);

      const ack = await new Promise<{ success: boolean; error?: string }>(
        (resolve) => {
          spectatorSocket.emit("game:start", { gameId }, resolve);
        },
      );

      expect(ack.success).toBe(false);
      expect(ack.error).toBe("SPECTATOR_CANNOT_ACT");
    } finally {
      sockets.forEach(disconnectSocket);
      disconnectSocket(spectatorSocket);
    }
  });

  it("spectator join is rejected for a CREATED (lobby) game", async () => {
    const userA = await createTestUser("SpectatorCreatedA");
    const spectatorUser = await createTestUser("SpectatorCreatedSpec");

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${userA.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 2, turnTimerSeconds: 30 });

    const gameId = createRes.body.gameId as string;

    const spectatorSocket = await createAuthenticatedSocket(
      ctx.baseUrl,
      spectatorUser.accessToken,
    );

    try {
      const ack = await new Promise<{ success: boolean; error?: string }>(
        (resolve) => {
          spectatorSocket.emit(
            "game:join",
            { gameId, role: "spectator" },
            resolve,
          );
        },
      );

      expect(ack.success).toBe(false);
      expect(ack.error).toBe("SPECTATING_NOT_AVAILABLE");
    } finally {
      disconnectSocket(spectatorSocket);
    }
  });

  it("spectator state contains cardCount but no hand field for players", async () => {
    const { sockets, gameId } = await setupInProgressGame(ctx);
    const spectatorUser = await createTestUser("SpectatorNoHandA");
    const spectatorSocket = await createAuthenticatedSocket(
      ctx.baseUrl,
      spectatorUser.accessToken,
    );

    try {
      const spectatorState = await joinAsSpectator(spectatorSocket, gameId);

      for (const player of spectatorState.players) {
        expect(typeof player.cardCount).toBe("number");
        expect(player.cardCount).toBeGreaterThan(0);
        // hand must not appear on PlayerPublicInfo
        expect("hand" in player).toBe(false);
      }

      // SpectatorView has no "you" field with a hand
      expect("you" in spectatorState).toBe(false);
    } finally {
      sockets.forEach(disconnectSocket);
      disconnectSocket(spectatorSocket);
    }
  });

  it("spectator receives final game:spectatorState when the game completes", async () => {
    const { sockets, gameId, initialStates } = await setupInProgressGame(ctx);
    const spectatorUser = await createTestUser("SpectatorCompleteA");
    const spectatorSocket = await createAuthenticatedSocket(
      ctx.baseUrl,
      spectatorUser.accessToken,
    );

    try {
      await joinAsSpectator(spectatorSocket, gameId);

      // Set up a promise that resolves when spectator sees the COMPLETED state
      const spectatorCompletedPromise = new Promise<EnrichedSpectatorView>(
        (resolve) => {
          spectatorSocket.on("game:spectatorState", function handler(state) {
            if (state.status === "COMPLETED") {
              spectatorSocket.off("game:spectatorState", handler);
              resolve(state);
            }
          });
        },
      );

      const finalPlayerState = await playGameToCompletion(
        sockets,
        gameId,
        initialStates,
      );

      expect(finalPlayerState.status).toBe("COMPLETED");

      const finalSpectatorState = await spectatorCompletedPromise;
      expect(finalSpectatorState.status).toBe("COMPLETED");
      expect(finalSpectatorState.scores).not.toBeNull();
    } finally {
      sockets.forEach(disconnectSocket);
      disconnectSocket(spectatorSocket);
    }
  });

  it("spectator can join a COMPLETED game and receives final state", async () => {
    const [userA, userB] = await Promise.all([
      createTestUser("SpectatorCompletedJoinA"),
      createTestUser("SpectatorCompletedJoinB"),
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

    const playerSockets = await Promise.all([
      createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
      createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
    ]);

    try {
      await joinGameRoom(playerSockets, gameId);
      const initialStates = await startGame(playerSockets, gameId);

      const finalState = await playGameToCompletion(
        playerSockets,
        gameId,
        initialStates,
      );

      expect(finalState.status).toBe("COMPLETED");

      // Now a new spectator joins the COMPLETED game
      const spectatorUser = await createTestUser("SpectatorCompletedJoinSpec");
      const spectatorSocket = await createAuthenticatedSocket(
        ctx.baseUrl,
        spectatorUser.accessToken,
      );

      try {
        const spectatorState = await joinAsSpectator(spectatorSocket, gameId);
        expect(spectatorState.status).toBe("COMPLETED");
        expect(spectatorState.scores).not.toBeNull();
        expect(spectatorState.winner).not.toBeNull();
      } finally {
        disconnectSocket(spectatorSocket);
      }
    } finally {
      playerSockets.forEach(disconnectSocket);
    }
  });

  it("player already in game cannot join as spectator", async () => {
    const [userA, userB] = await Promise.all([
      createTestUser("SpectatorPlayerRejA"),
      createTestUser("SpectatorPlayerRejB"),
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

    const playerSocketA = await createAuthenticatedSocket(
      ctx.baseUrl,
      userA!.accessToken,
    );
    const playerSocketB = await createAuthenticatedSocket(
      ctx.baseUrl,
      userB!.accessToken,
    );

    try {
      await joinGameRoom([playerSocketA, playerSocketB], gameId);
      await startGame([playerSocketA, playerSocketB], gameId);

      // userA is already a player — try to also join as spectator
      const ack = await new Promise<{ success: boolean; error?: string }>(
        (resolve) => {
          playerSocketA.emit(
            "game:join",
            { gameId, role: "spectator" },
            resolve,
          );
        },
      );

      expect(ack.success).toBe(false);
      expect(ack.error).toBe("You are already a player in this game");
    } finally {
      disconnectSocket(playerSocketA);
      disconnectSocket(playerSocketB);
    }
  });

  it("multiple spectators each receive game:spectatorState on player action", async () => {
    const { sockets, gameId, initialStates } = await setupInProgressGame(ctx);

    const [spectatorUserA, spectatorUserB] = await Promise.all([
      createTestUser("MultiSpecA"),
      createTestUser("MultiSpecB"),
    ]);

    const [spectatorSocketA, spectatorSocketB] = await Promise.all([
      createAuthenticatedSocket(ctx.baseUrl, spectatorUserA!.accessToken),
      createAuthenticatedSocket(ctx.baseUrl, spectatorUserB!.accessToken),
    ]);

    try {
      // Both spectators join and receive initial state
      await Promise.all([
        joinAsSpectator(spectatorSocketA, gameId),
        joinAsSpectator(spectatorSocketB, gameId),
      ]);

      // Set up listeners for next state update on both spectators BEFORE triggering action
      const nextStatesPromise = Promise.all([
        new Promise<EnrichedSpectatorView>((resolve) => {
          spectatorSocketA.once("game:spectatorState", resolve);
        }),
        new Promise<EnrichedSpectatorView>((resolve) => {
          spectatorSocketB.once("game:spectatorState", resolve);
        }),
      ]);

      // Play a card (first play is always free — lowest card works)
      const currentPlayerIndex = initialStates[0]!.currentPlayerIndex;
      const currentSocket = sockets[currentPlayerIndex]!;
      const currentView = initialStates[currentPlayerIndex]!;
      const lowestCard = [...currentView.you.hand].sort(
        (a, b) => cardValue(a) - cardValue(b),
      )[0]!;

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

      const [stateA, stateB] = await nextStatesPromise;

      expect(stateA.version).toBeGreaterThan(1);
      expect(stateB.version).toBeGreaterThan(1);
      expect(stateA.gameId).toBe(gameId);
      expect(stateB.gameId).toBe(gameId);
    } finally {
      sockets.forEach(disconnectSocket);
      disconnectSocket(spectatorSocketA);
      disconnectSocket(spectatorSocketB);
    }
  });

  it("spectator receives game:timerExpired when the turn timer fires", async () => {
    const [userA, userB] = await Promise.all([
      createTestUser("SpectatorTimerExpiredA"),
      createTestUser("SpectatorTimerExpiredB"),
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

    const playerSockets = await Promise.all([
      createAuthenticatedSocket(ctx.baseUrl, userA!.accessToken),
      createAuthenticatedSocket(ctx.baseUrl, userB!.accessToken),
    ]);

    const spectatorUser = await createTestUser("SpectatorTimerExpiredSpec");
    const spectatorSocket = await createAuthenticatedSocket(
      ctx.baseUrl,
      spectatorUser.accessToken,
    );

    try {
      await joinGameRoom(playerSockets, gameId);
      await startGame(playerSockets, gameId);

      await joinAsSpectator(spectatorSocket, gameId);

      const timerExpiredPromise = new Promise<{
        gameId: string;
        playerId: string;
        action: string;
      }>((resolve) => {
        spectatorSocket.once("game:timerExpired", resolve);
      });

      // Fire the timer via FakeTimerProvider
      const fired = ctx.timerProvider.fireAll();
      expect(fired).toBeGreaterThanOrEqual(1);

      const timerExpiredPayload = await timerExpiredPromise;
      expect(timerExpiredPayload.gameId).toBe(gameId);
      expect(typeof timerExpiredPayload.playerId).toBe("string");
      expect(["pass", "playCards"]).toContain(timerExpiredPayload.action);
    } finally {
      playerSockets.forEach(disconnectSocket);
      disconnectSocket(spectatorSocket);
    }
  });
});
