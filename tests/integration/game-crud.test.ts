import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  createTestServer,
  type TestServerContext,
} from "./helpers/testServer.js";
import { createTestUser } from "./helpers/supabaseUser.js";
import { createTestGuest } from "./helpers/guestUser.js";

describe("Game CRUD integration", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("creates a game and returns gameId + gameType", async () => {
    const user = await createTestUser("CrudCreator");

    const res = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });

    expect(res.status).toBe(200);
    expect(typeof res.body.gameId).toBe("string");
    expect(res.body.gameType).toBe("big2");
  });

  it("registered user joins a game", async () => {
    const userA = await createTestUser("CrudHostA");
    const userB = await createTestUser("CrudJoinerB");

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${userA.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });

    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    const joinRes = await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${userB.accessToken}`)
      .send({ gameId });

    expect(joinRes.status).toBe(200);
    expect(joinRes.body.gameId).toBe(gameId);
  });

  it("guest joins a game", async () => {
    const host = await createTestUser("CrudGuestHost");

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });

    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    const guest = await createTestGuest(ctx.app, gameId, "GuestJoiner");

    const joinRes = await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${guest.token}`)
      .send({ gameId });

    expect(joinRes.status).toBe(200);
    expect(joinRes.body.gameId).toBe(gameId);
  });

  it("rejects createGame from guest token", async () => {
    // Need a game to create a guest session first
    const host = await createTestUser("CrudGuestCreateHost");

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });

    const gameId = createRes.body.gameId as string;
    const guest = await createTestGuest(ctx.app, gameId, "GuestWhoCreates");

    const res = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${guest.token}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });

    expect(res.status).toBe(403);
  });

  it("returns game state via GET /getGameState", async () => {
    const userA = await createTestUser("StateHostA");
    const userB = await createTestUser("StateJoinerB");

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${userA.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });

    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${userB.accessToken}`)
      .send({ gameId });

    const stateRes = await request(ctx.app)
      .get(`/getGameState?gameId=${gameId}`)
      .set("Authorization", `Bearer ${userA.accessToken}`);

    expect(stateRes.status).toBe(200);
    const gameState = stateRes.body.gameState as {
      playerIds: string[];
      status: string;
    };
    expect(Array.isArray(gameState.playerIds)).toBe(true);
    expect(gameState.playerIds).toContain(userA.id);
    expect(gameState.playerIds).toContain(userB.id);
    expect(gameState.status).toBe("CREATED");
  });

  it("numAiSeats=2 creates a practice game with 2 AI seats in gameConfig.aiPlayerIds", async () => {
    const host = await createTestUser("PracticeHost");

    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({
        gameType: "big2",
        maxPlayers: 4,
        turnTimerSeconds: 30,
        numAiSeats: 2,
      });

    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    const stateRes = await request(ctx.app)
      .get(`/getGameState?gameId=${gameId}`)
      .set("Authorization", `Bearer ${host.accessToken}`);

    expect(stateRes.status).toBe(200);
    const gameState = stateRes.body.gameState as {
      playerIds: string[];
      gameConfig: { practice?: boolean; aiPlayerIds?: string[] };
    };

    // 1 human host + 2 AI seats
    expect(gameState.playerIds).toHaveLength(3);
    expect(gameState.playerIds).toContain(host.id);

    // gameConfig must carry practice flag and the 2 AI ids
    expect(gameState.gameConfig.practice).toBe(true);
    expect(Array.isArray(gameState.gameConfig.aiPlayerIds)).toBe(true);
    expect(gameState.gameConfig.aiPlayerIds).toHaveLength(2);

    // AI ids must be in playerIds and must not include the human host
    const aiIds = gameState.gameConfig.aiPlayerIds!;
    aiIds.forEach((aiId) => {
      expect(gameState.playerIds).toContain(aiId);
      expect(aiId).not.toBe(host.id);
    });
  });
});
