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
});
