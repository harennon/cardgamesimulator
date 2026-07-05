import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type {
  SubmitFeedbackResponse,
  SubmitAttachmentResponse,
  AdminFeedbackEntry,
} from "../../src/shared/model.js";
import {
  createTestServer,
  type TestServerContext,
} from "./helpers/testServer.js";
import { createTestUser } from "./helpers/supabaseUser.js";
import { createTestGuest } from "./helpers/guestUser.js";
import { SupabaseDB } from "../../src/backend/database/supabaseDb.js";

// Minimal real PNG (1×1 pixel) — reused from feedbackAttachment.test.ts
const MINIMAL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function pngBase64(): string {
  return MINIMAL_PNG_BASE64;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getFeedbackById(id: string) {
  const all = await SupabaseDB.INSTANCE.getAllFeedback();
  return all.find((f) => f.id === id) ?? null;
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

  // GET /feedback (admin-only)

  it("GET /feedback returns 403 for non-admin user", async () => {
    const user = await createTestUser("FeedbackNonAdmin");

    const res = await request(ctx.app)
      .get("/feedback")
      .set("Authorization", `Bearer ${user.accessToken}`);

    expect(res.status).toBe(403);
  });

  it("GET /feedback returns 401 without auth", async () => {
    const res = await request(ctx.app).get("/feedback");

    expect(res.status).toBe(401);
  });

  // DELETE /feedback/:id

  it("DELETE /feedback/:id returns 403 when userId is not in FEEDBACK_ADMIN_IDS", async () => {
    const user = await createTestUser("FeedbackDelNonAdmin");

    const res = await request(ctx.app)
      .delete("/feedback/some-fake-id")
      .set("Authorization", `Bearer ${user.accessToken}`);

    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe("Forbidden");
  });

  it("DELETE /feedback/:id returns 401 without auth", async () => {
    const res = await request(ctx.app).delete("/feedback/some-fake-id");

    expect(res.status).toBe(401);
  });

  it("DELETE /feedback/:id returns 404 when feedback does not exist", async () => {
    const admin = await createTestUser("FeedbackDelAdmin404");

    process.env.FEEDBACK_ADMIN_IDS = admin.id;
    try {
      const res = await request(ctx.app)
        .delete("/feedback/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${admin.accessToken}`);

      expect(res.status).toBe(404);
      expect((res.body as { error: string }).error).toBe("Feedback not found");
    } finally {
      delete process.env.FEEDBACK_ADMIN_IDS;
    }
  });

  it("DELETE /feedback/:id returns 200 and removes the feedback", async () => {
    const admin = await createTestUser("FeedbackDelAdmin200");

    // Create feedback first
    const createRes = await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ category: "bug", description: "To be deleted" });
    expect(createRes.status).toBe(201);
    const { id } = createRes.body as SubmitFeedbackResponse;

    process.env.FEEDBACK_ADMIN_IDS = admin.id;
    try {
      // Delete
      const delRes = await request(ctx.app)
        .delete(`/feedback/${id}`)
        .set("Authorization", `Bearer ${admin.accessToken}`);

      expect(delRes.status).toBe(200);
      expect((delRes.body as { deleted: string }).deleted).toBe(id);

      // Verify it's gone
      const getRes = await request(ctx.app)
        .get("/feedback")
        .set("Authorization", `Bearer ${admin.accessToken}`);
      expect(getRes.status).toBe(200);
      const items = getRes.body as Array<{ id: string }>;
      expect(items.find((f) => f.id === id)).toBeUndefined();
    } finally {
      delete process.env.FEEDBACK_ADMIN_IDS;
    }
  });

  it("DELETE /feedback/:id returns 404 on double-delete", async () => {
    const admin = await createTestUser("FeedbackDelDouble");

    // Create feedback
    const createRes = await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ category: "other", description: "Double delete test" });
    expect(createRes.status).toBe(201);
    const { id } = createRes.body as SubmitFeedbackResponse;

    process.env.FEEDBACK_ADMIN_IDS = admin.id;
    try {
      // First delete succeeds
      const delRes1 = await request(ctx.app)
        .delete(`/feedback/${id}`)
        .set("Authorization", `Bearer ${admin.accessToken}`);
      expect(delRes1.status).toBe(200);

      // Second delete returns 404
      const delRes2 = await request(ctx.app)
        .delete(`/feedback/${id}`)
        .set("Authorization", `Bearer ${admin.accessToken}`);
      expect(delRes2.status).toBe(404);
    } finally {
      delete process.env.FEEDBACK_ADMIN_IDS;
    }
  });

  it("GET /feedback returns feedback list for admin user", async () => {
    const admin = await createTestUser("FeedbackAdmin");

    // Submit feedback first
    await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ category: "bug", description: "Admin test feedback" });

    // Set admin ID env var (handler reads it per-request)
    process.env.FEEDBACK_ADMIN_IDS = admin.id;
    try {
      const res = await request(ctx.app)
        .get("/feedback")
        .set("Authorization", `Bearer ${admin.accessToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const items = res.body as Array<{
        id: string;
        category: string;
        description: string;
        createdAt: string;
      }>;
      expect(items.length).toBeGreaterThan(0);
      const found = items.find((f) => f.description === "Admin test feedback");
      expect(found).toBeDefined();
      expect(found!.category).toBe("bug");
      expect(found!.createdAt).toBeDefined();
    } finally {
      delete process.env.FEEDBACK_ADMIN_IDS;
    }
  });

  // GET /feedback — signed URL resolution (LLD 157)

  it("GET /feedback with an attached entry: attachments[0].url is a fetchable signed URL, not the raw key", async () => {
    const admin = await createTestUser("FeedbackSignedUrl");

    // Create feedback and upload an attachment.
    const createRes = await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ category: "bug", description: "Signed URL test" });
    expect(createRes.status).toBe(201);
    const { id } = createRes.body as SubmitFeedbackResponse;

    const attachRes = await request(ctx.app)
      .post(`/feedback/${id}/attachments`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ image: pngBase64(), mimeType: "image/png" });
    expect(attachRes.status).toBe(201);
    const { key } = attachRes.body as SubmitAttachmentResponse;

    process.env.FEEDBACK_ADMIN_IDS = admin.id;
    try {
      const getRes = await request(ctx.app)
        .get("/feedback")
        .set("Authorization", `Bearer ${admin.accessToken}`);
      expect(getRes.status).toBe(200);

      const items = getRes.body as AdminFeedbackEntry[];
      const entry = items.find((f) => f.id === id);
      expect(entry).toBeDefined();
      expect(entry!.attachments).toHaveLength(1);
      const link = entry!.attachments[0];

      // key field is the storage path
      expect(link.key).toBe(key);
      // url is a real HTTP URL, not the raw storage key
      expect(link.url).toMatch(/^https?:\/\//);
      expect(link.url).not.toBe(key);

      // URL is fetchable — proves it's a valid signed URL pointing to the object
      const fetched = await fetch(link.url);
      expect(fetched.ok).toBe(true);
    } finally {
      delete process.env.FEEDBACK_ADMIN_IDS;
    }
  });

  it("GET /feedback with no-attachment entry: attachments is [] and attachmentKeys is absent", async () => {
    const admin = await createTestUser("FeedbackNoAttach");

    const createRes = await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ category: "other", description: "No attachment entry" });
    expect(createRes.status).toBe(201);
    const { id } = createRes.body as SubmitFeedbackResponse;

    process.env.FEEDBACK_ADMIN_IDS = admin.id;
    try {
      const getRes = await request(ctx.app)
        .get("/feedback")
        .set("Authorization", `Bearer ${admin.accessToken}`);
      expect(getRes.status).toBe(200);

      const items = getRes.body as AdminFeedbackEntry[];
      const entry = items.find((f) => f.id === id);
      expect(entry).toBeDefined();
      expect(entry!.attachments).toEqual([]);
      // The old `attachmentKeys` field must NOT appear on the wire (replaced by `attachments`)
      expect("attachmentKeys" in entry!).toBe(false);
    } finally {
      delete process.env.FEEDBACK_ADMIN_IDS;
    }
  });

  it("GET /feedback signed URL contains Supabase token query params (short-lived, not a public URL)", async () => {
    const admin = await createTestUser("FeedbackSignedUrlParams");

    const createRes = await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ category: "bug", description: "Signed URL params test" });
    expect(createRes.status).toBe(201);
    const { id } = createRes.body as SubmitFeedbackResponse;

    await request(ctx.app)
      .post(`/feedback/${id}/attachments`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ image: pngBase64(), mimeType: "image/png" });

    process.env.FEEDBACK_ADMIN_IDS = admin.id;
    try {
      const getRes = await request(ctx.app)
        .get("/feedback")
        .set("Authorization", `Bearer ${admin.accessToken}`);
      expect(getRes.status).toBe(200);

      const items = getRes.body as AdminFeedbackEntry[];
      const entry = items.find((f) => f.id === id);
      expect(entry).toBeDefined();
      expect(entry!.attachments).toHaveLength(1);
      const { url } = entry!.attachments[0];

      // Supabase signed URLs include a `token` query parameter.
      // This confirms it's a signed (short-lived) URL, not a public object URL.
      const parsedUrl = new URL(url);
      expect(parsedUrl.searchParams.has("token")).toBe(true);
    } finally {
      delete process.env.FEEDBACK_ADMIN_IDS;
    }
  });
});
