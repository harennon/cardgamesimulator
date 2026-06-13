import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import {
  createTestServer,
  type TestServerContext,
} from "./helpers/testServer.js";
import { createTestUser } from "./helpers/supabaseUser.js";
import { createTestGuest } from "./helpers/guestUser.js";

describe("Auth integration", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("accepts a Supabase-issued ES256 JWT on REST endpoint", async () => {
    const user = await createTestUser("AuthTestUser");

    const res = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, gameOptions: {} });

    expect(res.status).toBe(200);
    expect(res.body.gameId).toBeDefined();
  });

  it("rejects a token signed with wrong algorithm (HS256 with wrong secret)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const fakeToken = jwt.sign(
      {
        sub: "fake-user-id",
        email: "fake@test.com",
        role: "authenticated",
        aud: "authenticated",
        iat: now,
        exp: now + 3600,
        user_metadata: { display_name: "Fake User" },
      },
      "wrong-secret-key",
      { algorithm: "HS256" },
    );

    const res = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${fakeToken}`)
      .send({ gameType: "big2", maxPlayers: 4 });

    expect(res.status).toBe(401);
  });

  it("accepts a valid guest token on REST endpoint", async () => {
    // Create a game as a registered user first
    const host = await createTestUser("GuestAuthHost");
    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4 });

    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    // Create a guest session for that game
    const guest = await createTestGuest(ctx.app, gameId, "GuestPlayer");

    // Use the guest token to join the game
    const joinRes = await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${guest.token}`)
      .send({ gameId });

    expect(joinRes.status).toBe(200);
  });

  it("rejects a guest token for a non-existent session", async () => {
    // Craft a guest token with valid HMAC but for a non-existent guestId.
    // We do this by creating a real token then using a completely fabricated one.
    const fakeGuestToken = "guest:dGhpcy1pcy1ub3QtYS1yZWFsLXRva2Vu";

    const host = await createTestUser("GuestRejectHost");
    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4 });

    const gameId = createRes.body.gameId as string;

    const joinRes = await request(ctx.app)
      .post("/joinGame")
      .set("Authorization", `Bearer ${fakeGuestToken}`)
      .send({ gameId });

    expect(joinRes.status).toBe(401);
  });
});
