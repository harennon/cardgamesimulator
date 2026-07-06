/**
 * Unit tests for LLD 158: FeedbackHandler.get — signed URL resolution.
 * No DB, no network. Uses vi.mock to stub feedbackRepo; spies on the
 * handler's attachmentService.getSignedUrl after import.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Feedback } from "../../src/backend/database/entities/Feedback.js";
import type { AdminFeedbackEntry } from "../../src/shared/model.js";

// ---------------------------------------------------------------------------
// Repo mock — populated per-test via mockResolvedValue
// ---------------------------------------------------------------------------

const mockGetAllFeedback = vi.fn<() => Promise<Feedback[]>>();

vi.mock("@/database", () => ({
  feedbackRepo: {
    createFeedback: vi.fn(),
    getAllFeedback: () => mockGetAllFeedback(),
    deleteFeedback: vi.fn(),
    getFeedbackById: vi.fn(),
    appendAttachmentKey: vi.fn(),
  },
}));

// Stub out SupabaseDB so the static INSTANCE initializer in submitFeedback.ts
// doesn't fail trying to connect. The actual storage is controlled via
// attachmentService.getSignedUrl spy below.
vi.mock("@/database/supabaseDb", () => ({
  SupabaseDB: {
    INSTANCE: { storageClient: {} },
  },
}));

vi.mock("@/service/attachmentStorage", () => ({
  SupabaseAttachmentStorage: class {
    createSignedUrl(_key: string, _ttl: number): Promise<string> {
      return Promise.resolve("https://stub/unused");
    }
    upload = vi.fn();
    remove = vi.fn();
    removeByPrefix = vi.fn();
  },
}));

// Import handler after mocks are registered.
const { FeedbackHandler } =
  await import("../../src/backend/api/feedback/submitFeedback.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFeedbackRow(overrides: Partial<Feedback> = {}): Feedback {
  const f = new Feedback();
  f.id = "fb-001";
  f.category = "bug";
  f.description = "Something broke";
  f.metadata = null;
  f.userId = "user-1";
  f.createdAt = new Date("2026-07-01T00:00:00.000Z");
  f.attachmentKeys = [];
  return Object.assign(f, overrides);
}

function makeRequest(adminUserId: string) {
  process.env.FEEDBACK_ADMIN_IDS = adminUserId;
  return {
    userId: adminUserId,
    query: {},
    headers: {},
    params: {},
  } as Parameters<(typeof FeedbackHandler.INSTANCE)["get"]>[0];
}

function makeResponse() {
  const data: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      data.statusCode = code;
      return res;
    },
    json(body: unknown) {
      data.body = body;
      return res;
    },
  };
  return { res, data };
}

// Access the attachmentService on the singleton so we can spy on getSignedUrl.
const handler = FeedbackHandler.INSTANCE as unknown as {
  attachmentService: {
    getSignedUrl: (key: string, ttl?: number) => Promise<string>;
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FeedbackHandler.get — signed URL resolution", () => {
  let getSignedUrlSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    getSignedUrlSpy = vi
      .spyOn(handler.attachmentService, "getSignedUrl")
      .mockImplementation(async (key) => `https://signed/${key}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FEEDBACK_ADMIN_IDS;
  });

  it("entry with attachments: response has attachments of length 2, index-aligned with attachmentKeys", async () => {
    const row = makeFeedbackRow({ attachmentKeys: ["k1", "k2"] });
    mockGetAllFeedback.mockResolvedValue([row]);

    const { res, data } = makeResponse();
    await FeedbackHandler.INSTANCE.get(makeRequest("admin-1"), res as never);

    expect(data.statusCode).toBe(200);
    const entries = data.body as AdminFeedbackEntry[];
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.attachments).toEqual([
      "https://signed/k1",
      "https://signed/k2",
    ]);
    expect(entry.attachmentKeys).toEqual(["k1", "k2"]);
    expect(entry.attachments).toHaveLength(2);
  });

  it("entry with no attachments: attachments is [] and getSignedUrl is never called", async () => {
    const row = makeFeedbackRow({ attachmentKeys: [] });
    mockGetAllFeedback.mockResolvedValue([row]);

    const { res, data } = makeResponse();
    await FeedbackHandler.INSTANCE.get(makeRequest("admin-1"), res as never);

    expect(data.statusCode).toBe(200);
    const entries = data.body as AdminFeedbackEntry[];
    expect(entries[0]!.attachments).toEqual([]);
    expect(getSignedUrlSpy).not.toHaveBeenCalled();
  });

  it("default TTL: getSignedUrl is called with no explicit TTL (relies on service default of 60 s)", async () => {
    // Confirm the handler calls getSignedUrl(key) with no second argument —
    // it should not pass a custom TTL, so no long-lived URL path exists.
    const row = makeFeedbackRow({ attachmentKeys: ["key-a"] });
    mockGetAllFeedback.mockResolvedValue([row]);

    const { res } = makeResponse();
    await FeedbackHandler.INSTANCE.get(makeRequest("admin-1"), res as never);

    expect(getSignedUrlSpy).toHaveBeenCalledOnce();
    // Called with only the key — no TTL override argument.
    expect(getSignedUrlSpy).toHaveBeenCalledWith("key-a");
  });

  it("signed values in attachments are the signed-URL form, not the raw storage key", async () => {
    const rawKey = "feedback-id/attachment-id.png";
    const row = makeFeedbackRow({ attachmentKeys: [rawKey] });
    mockGetAllFeedback.mockResolvedValue([row]);

    const { res, data } = makeResponse();
    await FeedbackHandler.INSTANCE.get(makeRequest("admin-1"), res as never);

    const entries = data.body as AdminFeedbackEntry[];
    const attachments = entries[0]!.attachments;
    expect(attachments[0]).toBe(`https://signed/${rawKey}`);
    expect(attachments[0]).not.toBe(rawKey);
  });

  it("getSignedUrl is called once per key", async () => {
    const row = makeFeedbackRow({ attachmentKeys: ["k1", "k2", "k3"] });
    mockGetAllFeedback.mockResolvedValue([row]);

    const { res } = makeResponse();
    await FeedbackHandler.INSTANCE.get(makeRequest("admin-1"), res as never);

    expect(getSignedUrlSpy).toHaveBeenCalledTimes(3);
    expect(getSignedUrlSpy).toHaveBeenCalledWith("k1");
    expect(getSignedUrlSpy).toHaveBeenCalledWith("k2");
    expect(getSignedUrlSpy).toHaveBeenCalledWith("k3");
  });

  it("non-admin caller gets 403 and no signing occurs", async () => {
    mockGetAllFeedback.mockResolvedValue([]);
    process.env.FEEDBACK_ADMIN_IDS = "real-admin";

    const nonAdminReq = {
      userId: "non-admin",
      query: {},
      headers: {},
      params: {},
    } as Parameters<(typeof FeedbackHandler.INSTANCE)["get"]>[0];

    const { res, data } = makeResponse();
    await FeedbackHandler.INSTANCE.get(nonAdminReq, res as never);

    expect(data.statusCode).toBe(403);
    expect(getSignedUrlSpy).not.toHaveBeenCalled();
  });

  it("response entries include all existing fields unchanged", async () => {
    const row = makeFeedbackRow({
      id: "fb-xyz",
      category: "feature-request",
      description: "Add dark mode",
      userId: "user-99",
      attachmentKeys: [],
    });
    row.createdAt = new Date("2026-06-15T10:00:00.000Z");
    mockGetAllFeedback.mockResolvedValue([row]);

    const { res, data } = makeResponse();
    await FeedbackHandler.INSTANCE.get(makeRequest("admin-1"), res as never);

    const entries = data.body as AdminFeedbackEntry[];
    const entry = entries[0]!;
    expect(entry.id).toBe("fb-xyz");
    expect(entry.category).toBe("feature-request");
    expect(entry.description).toBe("Add dark mode");
    expect(entry.userId).toBe("user-99");
    expect(entry.createdAt).toBe("2026-06-15T10:00:00.000Z");
    expect(entry.attachmentKeys).toEqual([]);
    expect(entry.attachments).toEqual([]);
  });
});
