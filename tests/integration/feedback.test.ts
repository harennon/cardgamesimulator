import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { DataSource } from "typeorm";
import type { SubmitFeedbackResponse } from "../../src/shared/model.js";
import {
  createTestServer,
  type TestServerContext,
} from "./helpers/testServer.js";
import { createTestUser } from "./helpers/supabaseUser.js";
import { createTestGuest } from "./helpers/guestUser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getFeedbackById(id: string) {
  const { PostgresDB } = await import("../../src/backend/database/postgres.js");
  const { Feedback } =
    await import("../../src/backend/database/entities/Feedback.js");
  const datasource = (
    PostgresDB.INSTANCE as unknown as { dataSource: DataSource }
  ).dataSource;
  return datasource.getRepository(Feedback).findOneBy({ id });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Feedback endpoint integration", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("POST /feedback returns 201 with valid input from a registered user", async () => {
    const user = await createTestUser("FeedbackUser1");

    const res = await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ category: "bug", description: "Something is broken" });

    expect(res.status).toBe(201);
    const body = res.body as SubmitFeedbackResponse;
    expect(body.id).toBeTruthy();
    expect(body.createdAt).toBeTruthy();
    expect(new Date(body.createdAt).getTime()).not.toBeNaN();
  });

  it("POST /feedback returns 201 for a guest user", async () => {
    const host = await createTestUser("FeedbackGuestHost");
    const createRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });
    expect(createRes.status).toBe(200);
    const gameId = createRes.body.gameId as string;

    const guest = await createTestGuest(ctx.app, gameId, "FeedbackGuest");

    const res = await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${guest.token}`)
      .send({ category: "other", description: "Guest feedback" });

    expect(res.status).toBe(201);
    const body = res.body as SubmitFeedbackResponse;
    expect(body.id).toBeTruthy();
  });

  it("POST /feedback returns 400 for empty description", async () => {
    const user = await createTestUser("FeedbackUser2");

    const res = await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ category: "bug", description: "" });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      "Description is required",
    );
  });

  it("POST /feedback returns 400 for invalid category", async () => {
    const user = await createTestUser("FeedbackUser3");

    const res = await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ category: "nonsense", description: "Valid description" });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("Invalid category");
  });

  it("POST /feedback returns 401 without an auth token", async () => {
    const res = await request(ctx.app)
      .post("/feedback")
      .send({ category: "bug", description: "No auth" });

    expect(res.status).toBe(401);
  });

  it("metadata is stored correctly", async () => {
    const user = await createTestUser("FeedbackMeta");
    const metadata = {
      route: "/game/test-123",
      gameId: "test-123",
      userType: "registered",
      browser: "TestBrowser/1.0",
      viewport: { width: 1920, height: 1080 },
      timestamp: "2026-06-15T00:00:00.000Z",
    };

    const res = await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({
        category: "feature-request",
        description: "Add dark mode",
        metadata,
      });

    expect(res.status).toBe(201);
    const { id } = res.body as SubmitFeedbackResponse;

    const stored = await getFeedbackById(id);
    expect(stored).not.toBeNull();
    expect(stored!.metadata).toEqual(metadata);
    expect(stored!.userId).toBe(user.id);
  });

  it("description is trimmed before storage", async () => {
    const user = await createTestUser("FeedbackTrim");

    const res = await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ category: "bug", description: "  trimmed content  " });

    expect(res.status).toBe(201);
    const { id } = res.body as SubmitFeedbackResponse;

    const stored = await getFeedbackById(id);
    expect(stored).not.toBeNull();
    expect(stored!.description).toBe("trimmed content");
  });
});
