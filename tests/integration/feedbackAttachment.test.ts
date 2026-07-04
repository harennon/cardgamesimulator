/**
 * Integration tests for LLD 153: feedback attachment upload/read path.
 * Requires: supabase start (local Supabase stack with migration 013 applied).
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import {
  createTestServer,
  type TestServerContext,
} from "./helpers/testServer.js";
import { createTestUser } from "./helpers/supabaseUser.js";
import { createTestGuest } from "./helpers/guestUser.js";
import { SupabaseDB } from "../../src/backend/database/supabaseDb.js";
import type {
  SubmitFeedbackResponse,
  SubmitAttachmentResponse,
} from "../../src/shared/model.js";
import {
  FeedbackAttachmentService,
  ATTACHMENT_LIMITS,
} from "../../src/backend/service/feedbackAttachmentService.js";
import { SupabaseAttachmentStorage } from "../../src/backend/service/attachmentStorage.js";

// ---------------------------------------------------------------------------
// Minimal real PNG (1×1 pixel) — 67 bytes, passes magic-byte check.
// ---------------------------------------------------------------------------
const MINIMAL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function pngBase64(): string {
  return MINIMAL_PNG_BASE64;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createFeedback(app: Express, token: string): Promise<string> {
  const res = await request(app)
    .post("/feedback")
    .set("Authorization", `Bearer ${token}`)
    .send({ category: "bug", description: "attachment test" });
  expect(res.status).toBe(201);
  return (res.body as SubmitFeedbackResponse).id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Feedback attachment integration", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    await ctx.close();
  });

  // -------------------------------------------------------------------------
  // Round-trip: upload → row has key → signed URL serves the bytes back
  // -------------------------------------------------------------------------

  it("POST /feedback/:id/attachments returns 201 and links the key to the row", async () => {
    const user = await createTestUser("AttachUser1");
    const feedbackId = await createFeedback(ctx.app, user.accessToken);

    const res = await request(ctx.app)
      .post(`/feedback/${feedbackId}/attachments`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ image: pngBase64(), mimeType: "image/png" });

    expect(res.status).toBe(201);
    const body = res.body as SubmitAttachmentResponse;
    expect(body.attachmentId).toBeTruthy();
    expect(body.key).toMatch(new RegExp(`^${feedbackId}/[0-9a-f-]+\\.png$`));

    // Row must reference the key; no binary stored.
    const row = await SupabaseDB.INSTANCE.getFeedbackById(feedbackId);
    expect(row).not.toBeNull();
    expect(row!.attachmentKeys).toContain(body.key);
    // The column is a text array — no binary in the row.
    for (const k of row!.attachmentKeys) {
      expect(typeof k).toBe("string");
    }
  });

  it("signed URL is issued and can be used to fetch the object", async () => {
    const user = await createTestUser("AttachSignedUrl");
    const feedbackId = await createFeedback(ctx.app, user.accessToken);

    const res = await request(ctx.app)
      .post(`/feedback/${feedbackId}/attachments`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ image: pngBase64(), mimeType: "image/png" });
    expect(res.status).toBe(201);
    const { key } = res.body as SubmitAttachmentResponse;

    // Get a signed URL via the service (slice 3 will expose this as a route).
    const storage = new SupabaseAttachmentStorage(
      () => SupabaseDB.INSTANCE.storageClient,
    );
    const svc = new FeedbackAttachmentService(SupabaseDB.INSTANCE, storage);
    const signedUrl = await svc.getSignedUrl(key, 60);
    expect(signedUrl).toMatch(/^https?:\/\//);

    // Fetch the signed URL to confirm the bytes are retrievable.
    const fetched = await fetch(signedUrl);
    expect(fetched.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Server-side rejection cases
  // -------------------------------------------------------------------------

  it("returns 400 for decoded size > cap (E1)", async () => {
    const user = await createTestUser("AttachTooBig");
    const feedbackId = await createFeedback(ctx.app, user.accessToken);

    // Build a buffer bigger than the cap and give it PNG magic bytes.
    const big = Buffer.alloc(ATTACHMENT_LIMITS.maxBytesPerFile + 1);
    big[0] = 0x89;
    big[1] = 0x50;
    big[2] = 0x4e;
    big[3] = 0x47;

    const res = await request(ctx.app)
      .post(`/feedback/${feedbackId}/attachments`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ image: big.toString("base64"), mimeType: "image/png" });

    expect(res.status).toBe(400);
  });

  it("returns 413 for raw body exceeding the route limit (E1 — proves errorHandler mapping)", async () => {
    const user = await createTestUser("AttachBodyLimit");
    const feedbackId = await createFeedback(ctx.app, user.accessToken);

    // Build a payload whose raw JSON representation is > 7 MB.
    const oversize = "A".repeat(7.5 * 1024 * 1024);

    const res = await request(ctx.app)
      .post(`/feedback/${feedbackId}/attachments`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ image: oversize, mimeType: "image/png" }));

    expect(res.status).toBe(413);
  });

  it("returns 400 when attachment count exceeds max (E2)", async () => {
    const user = await createTestUser("AttachOverCount");
    const feedbackId = await createFeedback(ctx.app, user.accessToken);

    // Upload maxPerReport attachments successfully.
    for (let i = 0; i < ATTACHMENT_LIMITS.maxPerReport; i++) {
      const r = await request(ctx.app)
        .post(`/feedback/${feedbackId}/attachments`)
        .set("Authorization", `Bearer ${user.accessToken}`)
        .send({ image: pngBase64(), mimeType: "image/png" });
      expect(r.status).toBe(201);
    }

    // One more should fail.
    const res = await request(ctx.app)
      .post(`/feedback/${feedbackId}/attachments`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ image: pngBase64(), mimeType: "image/png" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-image mime type (E3)", async () => {
    const user = await createTestUser("AttachBadMime");
    const feedbackId = await createFeedback(ctx.app, user.accessToken);

    const res = await request(ctx.app)
      .post(`/feedback/${feedbackId}/attachments`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ image: pngBase64(), mimeType: "application/pdf" });

    expect(res.status).toBe(400);
  });

  it("returns 400 for a declared/actual mime-type mismatch (E4)", async () => {
    const user = await createTestUser("AttachMimeMismatch");
    const feedbackId = await createFeedback(ctx.app, user.accessToken);

    // PNG bytes declared as JPEG.
    const res = await request(ctx.app)
      .post(`/feedback/${feedbackId}/attachments`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ image: pngBase64(), mimeType: "image/jpeg" });

    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Ownership (E6 / E9)
  // -------------------------------------------------------------------------

  it("returns 404 for a non-existent feedback id (E6)", async () => {
    const user = await createTestUser("AttachNoFeedback");

    const res = await request(ctx.app)
      .post(`/feedback/00000000-0000-0000-0000-000000000000/attachments`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ image: pngBase64(), mimeType: "image/png" });

    expect(res.status).toBe(404);
  });

  it("returns 201 when a guest attaches to their own row (E9)", async () => {
    // Create a game first so we can create a guest session.
    const host = await createTestUser("AttachGuestHost");
    const gameRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });
    expect(gameRes.status).toBe(200);
    const gameId = gameRes.body.gameId as string;

    const guest = await createTestGuest(ctx.app, gameId, "AttachGuest");

    // Guest submits feedback.
    const feedbackRes = await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${guest.token}`)
      .send({ category: "other", description: "guest attach test" });
    expect(feedbackRes.status).toBe(201);
    const feedbackId = (feedbackRes.body as SubmitFeedbackResponse).id;

    // Guest attaches to own row.
    const attachRes = await request(ctx.app)
      .post(`/feedback/${feedbackId}/attachments`)
      .set("Authorization", `Bearer ${guest.token}`)
      .send({ image: pngBase64(), mimeType: "image/png" });

    expect(attachRes.status).toBe(201);
  });

  it("returns 403 when a different guest tries to attach to another user's row", async () => {
    const host = await createTestUser("AttachGuestOwnerHost");
    const gameRes = await request(ctx.app)
      .post("/createGame")
      .set("Authorization", `Bearer ${host.accessToken}`)
      .send({ gameType: "big2", maxPlayers: 4, turnTimerSeconds: 30 });
    expect(gameRes.status).toBe(200);
    const gameId = gameRes.body.gameId as string;

    const guest1 = await createTestGuest(ctx.app, gameId, "GuestOwner");
    const guest2 = await createTestGuest(ctx.app, gameId, "GuestIntruder");

    // Guest1 submits feedback.
    const feedbackRes = await request(ctx.app)
      .post("/feedback")
      .set("Authorization", `Bearer ${guest1.token}`)
      .send({ category: "bug", description: "owner feedback" });
    expect(feedbackRes.status).toBe(201);
    const feedbackId = (feedbackRes.body as SubmitFeedbackResponse).id;

    // Guest2 tries to attach to Guest1's row.
    const res = await request(ctx.app)
      .post(`/feedback/${feedbackId}/attachments`)
      .set("Authorization", `Bearer ${guest2.token}`)
      .send({ image: pngBase64(), mimeType: "image/png" });

    expect(res.status).toBe(403);
  });

  it("returns 403 when a registered user tries to attach to another user's row", async () => {
    const owner = await createTestUser("AttachOwner");
    const intruder = await createTestUser("AttachIntruder");

    const feedbackId = await createFeedback(ctx.app, owner.accessToken);

    const res = await request(ctx.app)
      .post(`/feedback/${feedbackId}/attachments`)
      .set("Authorization", `Bearer ${intruder.accessToken}`)
      .send({ image: pngBase64(), mimeType: "image/png" });

    expect(res.status).toBe(403);
  });

  it("returns 201 when an admin attaches to any row", async () => {
    const owner = await createTestUser("AttachOwnForAdmin");
    const admin = await createTestUser("AttachAdminUser");
    const feedbackId = await createFeedback(ctx.app, owner.accessToken);

    process.env.FEEDBACK_ADMIN_IDS = admin.id;
    try {
      const res = await request(ctx.app)
        .post(`/feedback/${feedbackId}/attachments`)
        .set("Authorization", `Bearer ${admin.accessToken}`)
        .send({ image: pngBase64(), mimeType: "image/png" });

      expect(res.status).toBe(201);
    } finally {
      delete process.env.FEEDBACK_ADMIN_IDS;
    }
  });

  // -------------------------------------------------------------------------
  // Delete-path cleanup (retention)
  // -------------------------------------------------------------------------

  it("DELETE /feedback/:id removes both the row and its storage objects", async () => {
    const admin = await createTestUser("AttachDeleteAdmin");
    const feedbackId = await createFeedback(ctx.app, admin.accessToken);

    // Upload an attachment.
    const attachRes = await request(ctx.app)
      .post(`/feedback/${feedbackId}/attachments`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ image: pngBase64(), mimeType: "image/png" });
    expect(attachRes.status).toBe(201);
    const { key } = attachRes.body as SubmitAttachmentResponse;

    process.env.FEEDBACK_ADMIN_IDS = admin.id;
    try {
      const delRes = await request(ctx.app)
        .delete(`/feedback/${feedbackId}`)
        .set("Authorization", `Bearer ${admin.accessToken}`);
      expect(delRes.status).toBe(200);

      // Row must be gone.
      const row = await SupabaseDB.INSTANCE.getFeedbackById(feedbackId);
      expect(row).toBeNull();

      // Object must be gone from Storage.
      const { data } = await SupabaseDB.INSTANCE.storageClient.storage
        .from("feedback-attachments")
        .list(feedbackId);
      const names = (data ?? []).map((o) => `${feedbackId}/${o.name}`);
      expect(names).not.toContain(key);
    } finally {
      delete process.env.FEEDBACK_ADMIN_IDS;
    }
  });

  it("DELETE /feedback/:id with transient removeByPrefix failure leaves the row intact", async () => {
    const admin = await createTestUser("AttachDeleteRetry");
    const feedbackId = await createFeedback(ctx.app, admin.accessToken);

    const attachRes = await request(ctx.app)
      .post(`/feedback/${feedbackId}/attachments`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ image: pngBase64(), mimeType: "image/png" });
    expect(attachRes.status).toBe(201);

    // Patch removeStoragePrefix on the FeedbackHandler's attachmentService to
    // throw once, then succeed.
    const handler = (
      await import("../../src/backend/api/feedback/submitFeedback.js")
    ).FeedbackHandler.INSTANCE as {
      attachmentService: {
        removeStoragePrefix: (id: string) => Promise<void>;
      };
    };

    const original = handler.attachmentService.removeStoragePrefix.bind(
      handler.attachmentService,
    );
    let callCount = 0;
    vi.spyOn(
      handler.attachmentService,
      "removeStoragePrefix",
    ).mockImplementation(async (id: string) => {
      callCount++;
      if (callCount === 1) throw new Error("transient storage error");
      return original(id);
    });

    process.env.FEEDBACK_ADMIN_IDS = admin.id;
    try {
      // First DELETE → 500 (storage threw).
      const del1 = await request(ctx.app)
        .delete(`/feedback/${feedbackId}`)
        .set("Authorization", `Bearer ${admin.accessToken}`);
      expect(del1.status).toBe(500);

      // Row must still exist.
      const rowAfterFailure =
        await SupabaseDB.INSTANCE.getFeedbackById(feedbackId);
      expect(rowAfterFailure).not.toBeNull();

      // Retry → 200, row and objects gone.
      const del2 = await request(ctx.app)
        .delete(`/feedback/${feedbackId}`)
        .set("Authorization", `Bearer ${admin.accessToken}`);
      expect(del2.status).toBe(200);

      const rowAfterSuccess =
        await SupabaseDB.INSTANCE.getFeedbackById(feedbackId);
      expect(rowAfterSuccess).toBeNull();
    } finally {
      vi.restoreAllMocks();
      delete process.env.FEEDBACK_ADMIN_IDS;
    }
  });
});
