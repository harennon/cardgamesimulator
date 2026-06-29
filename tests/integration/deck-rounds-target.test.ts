import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  createTestServer,
  type TestServerContext,
} from "./helpers/testServer.js";
import { createTestUser } from "./helpers/supabaseUser.js";
import {
  deckCount,
  recoverDeckRoundsTarget,
} from "../../src/backend/engine/tonk/deck.js";
import type { TonkState } from "../../src/backend/engine/tonk/tonk-types.js";

// ---------------------------------------------------------------------------
// LLD 95: end-to-end persistence of the creator-supplied deckRoundsTarget
// through the game_config JSONB column. Create (HTTP) -> join -> load+start
// (gameService, which re-reads the row from the DB) -> assert the engine-built
// Tonk deck reflects the configured target, proving the value survives
// persist -> load -> start. Big2 is a regression guard for the Restart
// constraint (its game_config must stay {} and it must start normally).
// ---------------------------------------------------------------------------

async function createGame(
  ctx: TestServerContext,
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await request(ctx.app)
    .post("/createGame")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
  expect(res.status).toBe(200);
  return res.body.gameId as string;
}

async function joinGame(
  ctx: TestServerContext,
  token: string,
  gameId: string,
): Promise<void> {
  const res = await request(ctx.app)
    .post("/joinGame")
    .set("Authorization", `Bearer ${token}`)
    .send({ gameId });
  expect(res.status).toBe(200);
}

describe("LLD 95: deckRoundsTarget round-trip (create -> persist -> load -> start)", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("a Tonk game created with deckRoundsTarget: 6 builds a deck whose recovered target is 6", async () => {
    const [host, b, c] = await Promise.all([
      createTestUser("DrtTonkHost"),
      createTestUser("DrtTonkB"),
      createTestUser("DrtTonkC"),
    ]);

    const gameId = await createGame(ctx, host.accessToken, {
      gameType: "tonk",
      maxPlayers: 4,
      turnTimerSeconds: 30,
      deckRoundsTarget: 6,
    });
    await joinGame(ctx, b.accessToken, gameId);
    await joinGame(ctx, c.accessToken, gameId);

    // The persisted game_config survives the round-trip: startGame re-reads the
    // row from the DB before initializing the engine.
    const persisted = await ctx.gameService.getGame(gameId);
    expect(persisted!.gameConfig).toEqual({ deckRoundsTarget: 6 });

    const state = await ctx.gameService.startGame(gameId, host.id);
    const tonk = state.gameSpecificState as TonkState;
    const playerCount = state.players.length;
    const recovered = recoverDeckRoundsTarget(
      playerCount,
      deckCount(playerCount),
      tonk.trickDeckSize,
    );
    expect(recovered).toBe(6);
  });

  it("a Tonk game with deckRoundsTarget omitted defaults to a recovered target of 8", async () => {
    const [host, b, c] = await Promise.all([
      createTestUser("DrtTonkDefHost"),
      createTestUser("DrtTonkDefB"),
      createTestUser("DrtTonkDefC"),
    ]);

    const gameId = await createGame(ctx, host.accessToken, {
      gameType: "tonk",
      maxPlayers: 4,
      turnTimerSeconds: 30,
    });
    await joinGame(ctx, b.accessToken, gameId);
    await joinGame(ctx, c.accessToken, gameId);

    const persisted = await ctx.gameService.getGame(gameId);
    expect(persisted!.gameConfig).toEqual({ deckRoundsTarget: 8 });

    const state = await ctx.gameService.startGame(gameId, host.id);
    const tonk = state.gameSpecificState as TonkState;
    const playerCount = state.players.length;
    const recovered = recoverDeckRoundsTarget(
      playerCount,
      deckCount(playerCount),
      tonk.trickDeckSize,
    );
    expect(recovered).toBe(8);
  });

  it("a Big2 game starts normally and its game_config stays {} (Restart regression guard)", async () => {
    const [host, b] = await Promise.all([
      createTestUser("DrtBig2Host"),
      createTestUser("DrtBig2B"),
    ]);

    const gameId = await createGame(ctx, host.accessToken, {
      gameType: "big2",
      maxPlayers: 4,
      turnTimerSeconds: 30,
    });
    await joinGame(ctx, b.accessToken, gameId);

    const persisted = await ctx.gameService.getGame(gameId);
    expect(persisted!.gameConfig).toEqual({});

    const state = await ctx.gameService.startGame(gameId, host.id);
    expect(state.status).toBe("IN_PROGRESS");
    expect(state.gameType).toBe("big2");
  });

  it("rejects createGame with an out-of-range deckRoundsTarget (400)", async () => {
    const host = await createTestUser("DrtRejectHost");
    const res = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({
        gameType: "tonk",
        maxPlayers: 4,
        turnTimerSeconds: 30,
        deckRoundsTarget: 99,
      });
    expect(res.status).toBe(400);
  });
});
