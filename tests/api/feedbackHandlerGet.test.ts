/**
 * Unit tests for FeedbackHandler.get — resolveAttachments logic.
 * No DB, no network. Uses in-memory doubles for storage and feedback repo.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Feedback } from "../../src/backend/database/entities/Feedback.js";
import type { AdminFeedbackEntry } from "../../src/shared/model.js";

// ---------------------------------------------------------------------------
// In-memory doubles (mirrors feedbackAttachmentService.test.ts doubles)
// ---------------------------------------------------------------------------

function makeFeedbackRow(overrides: Partial<Feedback> = {}): Feedback {
  const f = new Feedback();
  f.id = "fb-id-1";
  f.category = "bug";
  f.description = "Something broke";
  f.metadata = { route: "/game/123", userType: "registered" };
  f.userId = "user-1";
  f.createdAt = new Date("2026-01-01T00:00:00.000Z");
  f.attachmentKeys = [];
  return Object.assign(f, overrides);
}

let mockGetAllFeedback: ReturnType<typeof vi.fn>;

vi.mock("@/database", () => ({
  feedbackRepo: {
    getAllFeedback: (...args: unknown[]) => mockGetAllFeedback(...args),
    getFeedbackById: vi.fn(),
    createFeedback: vi.fn(),
    deleteFeedback: vi.fn(),
    appendAttachmentKey: vi.fn(),
  },
}));

vi.mock("@/service/attachmentStorage", () => ({
  SupabaseAttachmentStorage: class {
    createSignedUrl() {
      return Promise.resolve("https://placeholder.url");
    }
    upload() {
      return Promise.resolve();
    }
    remove() {
      return Promise.resolve();
    }
    removeByPrefix() {
      return Promise.resolve();
    }
  },
}));

vi.mock("@/database/supabaseDb", () => ({
  SupabaseDB: {
    INSTANCE: {
      storageClient: {},
    },
  },
}));

process.env.SUPABASE_JWT_SECRET = "test-secret";

const { FeedbackHandler } =
  await import("../../src/backend/api/feedback/submitFeedback.js");

// Access the private attachmentService via a type cast for spying
type HandlerWithPrivates = {
  attachmentService: {
    getSignedUrl: (key: string, ttl?: number) => Promise<string>;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: { userId?: string } = {}): { userId?: string } {
  return { userId: "admin-user", ...overrides };
}

function makeResponse() {
  let statusCode = 0;
  let body: unknown = undefined;
  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: unknown) {
      body = data;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FeedbackHandler.get — resolveAttachments", () => {
  let getSignedUrlSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.FEEDBACK_ADMIN_IDS = "admin-user";

    mockGetAllFeedback = vi.fn();

    // Spy on the attachmentService.getSignedUrl so each test can control
    // signing behaviour without reaching the real Supabase storage.
    getSignedUrlSpy = vi
      .spyOn(
        (FeedbackHandler.INSTANCE as unknown as HandlerWithPrivates)
          .attachmentService,
        "getSignedUrl",
      )
      .mockImplementation(async (key: string) => `https://signed.url/${key}`);
  });

  it("entry with two attachment keys resolves to two AttachmentLink objects with signed URLs", async () => {
    const row = makeFeedbackRow({
      attachmentKeys: ["fb-id-1/att-1.png", "fb-id-1/att-2.png"],
    });
    mockGetAllFeedback.mockResolvedValue([row]);

    const req = makeRequest();
    const res = makeResponse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await FeedbackHandler.INSTANCE.get(req as any, res as any);

    expect(res.statusCode).toBe(200);
    const entries = res.body as AdminFeedbackEntry[];
    expect(entries).toHaveLength(1);
    const { attachments } = entries[0];
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toEqual({
      key: "fb-id-1/att-1.png",
      url: "https://signed.url/fb-id-1/att-1.png",
    });
    expect(attachments[1]).toEqual({
      key: "fb-id-1/att-2.png",
      url: "https://signed.url/fb-id-1/att-2.png",
    });
  });

  it("entry with no attachments returns attachments:[] and does not call getSignedUrl", async () => {
    const row = makeFeedbackRow({ attachmentKeys: [] });
    mockGetAllFeedback.mockResolvedValue([row]);

    const req = makeRequest();
    const res = makeResponse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await FeedbackHandler.INSTANCE.get(req as any, res as any);

    expect(res.statusCode).toBe(200);
    const entries = res.body as AdminFeedbackEntry[];
    expect(entries[0].attachments).toEqual([]);
    expect(getSignedUrlSpy).not.toHaveBeenCalled();
  });

  it("entry with no attachments preserves all other fields unchanged", async () => {
    const row = makeFeedbackRow({ attachmentKeys: [] });
    mockGetAllFeedback.mockResolvedValue([row]);

    const req = makeRequest();
    const res = makeResponse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await FeedbackHandler.INSTANCE.get(req as any, res as any);

    const entries = res.body as AdminFeedbackEntry[];
    const entry = entries[0];
    expect(entry.id).toBe("fb-id-1");
    expect(entry.category).toBe("bug");
    expect(entry.description).toBe("Something broke");
    expect(entry.metadata).toEqual({
      route: "/game/123",
      userType: "registered",
    });
    expect(entry.userId).toBe("user-1");
    expect(entry.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(entry.attachments).toEqual([]);
    // no `attachmentKeys` field on the wire
    expect("attachmentKeys" in entry).toBe(false);
  });

  it("signing failure for one of two keys: omits the failed key, keeps the good one, logs a warning", async () => {
    const row = makeFeedbackRow({
      attachmentKeys: ["fb-id-1/good.png", "fb-id-1/bad.png"],
    });
    mockGetAllFeedback.mockResolvedValue([row]);

    getSignedUrlSpy.mockImplementation(async (key: string) => {
      if (key.includes("bad")) throw new Error("transient error");
      return `https://signed.url/${key}`;
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const req = makeRequest();
    const res = makeResponse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await FeedbackHandler.INSTANCE.get(req as any, res as any);

    expect(res.statusCode).toBe(200);
    const entries = res.body as AdminFeedbackEntry[];
    const { attachments } = entries[0];
    // only the good key survived
    expect(attachments).toHaveLength(1);
    expect(attachments[0].key).toBe("fb-id-1/good.png");
    // the failed key must NEVER appear as a url
    expect(attachments.map((a) => a.url)).not.toContain("fb-id-1/bad.png");
    // warning was logged
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("all keys for an entry fail to sign: entry has attachments:[], still returns 200", async () => {
    const row = makeFeedbackRow({
      attachmentKeys: ["fb-id-1/att-1.png"],
    });
    mockGetAllFeedback.mockResolvedValue([row]);

    getSignedUrlSpy.mockRejectedValue(new Error("storage down"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const req = makeRequest();
    const res = makeResponse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await FeedbackHandler.INSTANCE.get(req as any, res as any);

    expect(res.statusCode).toBe(200);
    const entries = res.body as AdminFeedbackEntry[];
    expect(entries[0].attachments).toEqual([]);
    warnSpy.mockRestore();
  });

  it("mixed list: empty entry issues zero signing calls; non-empty entry issues exactly keys.length calls", async () => {
    const emptyRow = makeFeedbackRow({ id: "empty-id", attachmentKeys: [] });
    const attachedRow = makeFeedbackRow({
      id: "attached-id",
      attachmentKeys: ["attached-id/att-1.png", "attached-id/att-2.png"],
    });
    mockGetAllFeedback.mockResolvedValue([emptyRow, attachedRow]);

    const req = makeRequest();
    const res = makeResponse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await FeedbackHandler.INSTANCE.get(req as any, res as any);

    // getSignedUrl called exactly twice (one per key in the attached entry)
    expect(getSignedUrlSpy).toHaveBeenCalledTimes(2);
    expect(getSignedUrlSpy).toHaveBeenCalledWith("attached-id/att-1.png");
    expect(getSignedUrlSpy).toHaveBeenCalledWith("attached-id/att-2.png");
  });

  it("handler calls getSignedUrl with a single argument (inherits 60s default TTL, no explicit long TTL)", async () => {
    const row = makeFeedbackRow({ attachmentKeys: ["fb-id-1/att.png"] });
    mockGetAllFeedback.mockResolvedValue([row]);

    const req = makeRequest();
    const res = makeResponse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await FeedbackHandler.INSTANCE.get(req as any, res as any);

    // Handler must call getSignedUrl(key) — no explicit ttl argument —
    // so it inherits the service default of 60s.
    expect(getSignedUrlSpy).toHaveBeenCalledWith("fb-id-1/att.png");
    expect(getSignedUrlSpy).not.toHaveBeenCalledWith(
      "fb-id-1/att.png",
      expect.any(Number),
    );
  });

  it("non-admin returns 403 before any signing occurs", async () => {
    mockGetAllFeedback.mockResolvedValue([]);

    const req = makeRequest({ userId: "non-admin" });
    const res = makeResponse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await FeedbackHandler.INSTANCE.get(req as any, res as any);

    expect(res.statusCode).toBe(403);
    expect(getSignedUrlSpy).not.toHaveBeenCalled();
  });
});
