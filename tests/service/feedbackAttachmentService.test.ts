import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FeedbackAttachmentService,
  AttachmentValidationError,
  ATTACHMENT_LIMITS,
  type AttachmentInput,
} from "../../src/backend/service/feedbackAttachmentService.js";
import type { FeedbackRepository } from "../../src/backend/database/database.js";
import type { AttachmentStorage } from "../../src/backend/service/attachmentStorage.js";
import { Feedback } from "../../src/backend/database/entities/Feedback.js";
import {
  NotFoundError,
  AccessDeniedError,
} from "../../src/backend/util/errors.js";

// ---------------------------------------------------------------------------
// Magic-byte helpers
// ---------------------------------------------------------------------------

function makePng(): Buffer {
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A
  const b = Buffer.alloc(16);
  b[0] = 0x89;
  b[1] = 0x50;
  b[2] = 0x4e;
  b[3] = 0x47;
  return b;
}

function makeJpeg(): Buffer {
  const b = Buffer.alloc(16);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return b;
}

function makeWebp(): Buffer {
  // RIFF....WEBP
  const b = Buffer.alloc(16);
  b[0] = 0x52;
  b[1] = 0x49;
  b[2] = 0x46;
  b[3] = 0x46; // RIFF
  b[8] = 0x57;
  b[9] = 0x45;
  b[10] = 0x42;
  b[11] = 0x50; // WEBP
  return b;
}

// ---------------------------------------------------------------------------
// In-memory doubles
// ---------------------------------------------------------------------------

function makeFeedbackRow(overrides: Partial<Feedback> = {}): Feedback {
  const f = new Feedback();
  f.id = "fb-id-123";
  f.userId = "owner-user";
  f.attachmentKeys = [];
  return Object.assign(f, overrides);
}

function makeFeedbackRepo(
  overrides: Partial<FeedbackRepository> = {},
): FeedbackRepository {
  return {
    createFeedback: vi.fn(),
    getAllFeedback: vi.fn(),
    deleteFeedback: vi.fn(),
    getFeedbackById: vi.fn().mockResolvedValue(makeFeedbackRow()),
    appendAttachmentKey: vi.fn().mockImplementation(async (_id, key) => [key]),
    ...overrides,
  };
}

function makeStorage(
  overrides: Partial<AttachmentStorage> = {},
): AttachmentStorage {
  return {
    upload: vi.fn().mockResolvedValue(undefined),
    createSignedUrl: vi.fn().mockResolvedValue("https://signed.url/test"),
    remove: vi.fn().mockResolvedValue(undefined),
    removeByPrefix: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeInput(overrides: Partial<AttachmentInput> = {}): AttachmentInput {
  return {
    feedbackId: "fb-id-123",
    requesterId: "owner-user",
    isAdmin: false,
    data: makePng(),
    mimeType: "image/png",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FeedbackAttachmentService.addAttachment", () => {
  describe("Mime-type validation (E3)", () => {
    it("rejects a disallowed mime type", async () => {
      const svc = new FeedbackAttachmentService(
        makeFeedbackRepo(),
        makeStorage(),
      );
      await expect(
        svc.addAttachment(
          makeInput({ mimeType: "image/gif", data: makePng() }),
        ),
      ).rejects.toThrow(AttachmentValidationError);
    });

    it("accepts image/png", async () => {
      const svc = new FeedbackAttachmentService(
        makeFeedbackRepo(),
        makeStorage(),
      );
      await expect(
        svc.addAttachment(
          makeInput({ mimeType: "image/png", data: makePng() }),
        ),
      ).resolves.toBeDefined();
    });

    it("accepts image/jpeg", async () => {
      const svc = new FeedbackAttachmentService(
        makeFeedbackRepo(),
        makeStorage(),
      );
      await expect(
        svc.addAttachment(
          makeInput({ mimeType: "image/jpeg", data: makeJpeg() }),
        ),
      ).resolves.toBeDefined();
    });

    it("accepts image/webp", async () => {
      const svc = new FeedbackAttachmentService(
        makeFeedbackRepo(),
        makeStorage(),
      );
      await expect(
        svc.addAttachment(
          makeInput({ mimeType: "image/webp", data: makeWebp() }),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("Size validation (E1 / E10)", () => {
    it("rejects a zero-byte buffer (E10)", async () => {
      const svc = new FeedbackAttachmentService(
        makeFeedbackRepo(),
        makeStorage(),
      );
      await expect(
        svc.addAttachment(makeInput({ data: Buffer.alloc(0) })),
      ).rejects.toThrow(AttachmentValidationError);
    });

    it("rejects a buffer exceeding the byte cap (E1)", async () => {
      const big = Buffer.alloc(ATTACHMENT_LIMITS.maxBytesPerFile + 1);
      // Set PNG magic so it passes the magic-byte check if size were allowed.
      big[0] = 0x89;
      big[1] = 0x50;
      big[2] = 0x4e;
      big[3] = 0x47;
      const svc = new FeedbackAttachmentService(
        makeFeedbackRepo(),
        makeStorage(),
      );
      await expect(svc.addAttachment(makeInput({ data: big }))).rejects.toThrow(
        AttachmentValidationError,
      );
    });

    it("accepts a buffer of exactly maxBytesPerFile", async () => {
      const exact = Buffer.alloc(ATTACHMENT_LIMITS.maxBytesPerFile);
      exact[0] = 0x89;
      exact[1] = 0x50;
      exact[2] = 0x4e;
      exact[3] = 0x47;
      const svc = new FeedbackAttachmentService(
        makeFeedbackRepo(),
        makeStorage(),
      );
      await expect(
        svc.addAttachment(makeInput({ data: exact })),
      ).resolves.toBeDefined();
    });
  });

  describe("Pre-upload count guard (E2)", () => {
    it("rejects when the row already holds maxPerReport keys", async () => {
      const full = makeFeedbackRow({
        attachmentKeys: ["k1", "k2", "k3"],
      });
      const repo = makeFeedbackRepo({
        getFeedbackById: vi.fn().mockResolvedValue(full),
      });
      const storage = makeStorage();
      const svc = new FeedbackAttachmentService(repo, storage);
      await expect(svc.addAttachment(makeInput())).rejects.toThrow(
        AttachmentValidationError,
      );
      expect(storage.upload).not.toHaveBeenCalled();
    });
  });

  describe("Magic-byte cross-check (E4)", () => {
    it("rejects PNG magic bytes when mimeType is image/jpeg", async () => {
      const svc = new FeedbackAttachmentService(
        makeFeedbackRepo(),
        makeStorage(),
      );
      await expect(
        svc.addAttachment(
          makeInput({ mimeType: "image/jpeg", data: makePng() }),
        ),
      ).rejects.toThrow(AttachmentValidationError);
    });

    it("rejects JPEG magic bytes when mimeType is image/png", async () => {
      const svc = new FeedbackAttachmentService(
        makeFeedbackRepo(),
        makeStorage(),
      );
      await expect(
        svc.addAttachment(
          makeInput({ mimeType: "image/png", data: makeJpeg() }),
        ),
      ).rejects.toThrow(AttachmentValidationError);
    });

    it("accepts WebP RIFF-container detection", async () => {
      const svc = new FeedbackAttachmentService(
        makeFeedbackRepo(),
        makeStorage(),
      );
      await expect(
        svc.addAttachment(
          makeInput({ mimeType: "image/webp", data: makeWebp() }),
        ),
      ).resolves.toBeDefined();
    });

    it("rejects non-WebP bytes when mimeType is image/webp", async () => {
      const svc = new FeedbackAttachmentService(
        makeFeedbackRepo(),
        makeStorage(),
      );
      await expect(
        svc.addAttachment(
          makeInput({ mimeType: "image/webp", data: makePng() }),
        ),
      ).rejects.toThrow(AttachmentValidationError);
    });
  });

  describe("Ownership (E6 / E9)", () => {
    it("throws NotFoundError when getFeedbackById returns null", async () => {
      const repo = makeFeedbackRepo({
        getFeedbackById: vi.fn().mockResolvedValue(null),
      });
      const storage = makeStorage();
      const svc = new FeedbackAttachmentService(repo, storage);
      await expect(svc.addAttachment(makeInput())).rejects.toThrow(
        NotFoundError,
      );
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("throws AccessDeniedError when requesterId does not match row.userId (non-admin)", async () => {
      const repo = makeFeedbackRepo({
        getFeedbackById: vi
          .fn()
          .mockResolvedValue(makeFeedbackRow({ userId: "other-user" })),
      });
      const storage = makeStorage();
      const svc = new FeedbackAttachmentService(repo, storage);
      await expect(
        svc.addAttachment(
          makeInput({ requesterId: "different-user", isAdmin: false }),
        ),
      ).rejects.toThrow(AccessDeniedError);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("allows when requesterId matches row.userId (guest or registered)", async () => {
      const svc = new FeedbackAttachmentService(
        makeFeedbackRepo(),
        makeStorage(),
      );
      await expect(
        svc.addAttachment(makeInput({ requesterId: "owner-user" })),
      ).resolves.toBeDefined();
    });

    it("allows when isAdmin=true regardless of row.userId", async () => {
      const repo = makeFeedbackRepo({
        getFeedbackById: vi
          .fn()
          .mockResolvedValue(makeFeedbackRow({ userId: "some-other-user" })),
      });
      const svc = new FeedbackAttachmentService(repo, makeStorage());
      await expect(
        svc.addAttachment(
          makeInput({ requesterId: "admin-id", isAdmin: true }),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe("Happy path — key format and storage call", () => {
    it("calls storage.upload with the expected key format and returns attachmentId", async () => {
      const storage = makeStorage();
      const svc = new FeedbackAttachmentService(makeFeedbackRepo(), storage);
      const result = await svc.addAttachment(makeInput());

      expect(result.attachmentId).toBeTruthy();
      expect(result.key).toMatch(/^fb-id-123\/[0-9a-f-]+\.png$/);
      expect(storage.upload).toHaveBeenCalledWith(
        result.key,
        expect.any(Buffer),
        "image/png",
      );
    });

    it("appends exactly the returned key via appendAttachmentKey", async () => {
      const repo = makeFeedbackRepo();
      const svc = new FeedbackAttachmentService(repo, makeStorage());
      const result = await svc.addAttachment(makeInput());

      expect(repo.appendAttachmentKey).toHaveBeenCalledWith(
        "fb-id-123",
        result.key,
      );
    });
  });

  describe("Storage upload failure (E7)", () => {
    it("does not call appendAttachmentKey when storage.upload rejects", async () => {
      const repo = makeFeedbackRepo();
      const storage = makeStorage({
        upload: vi.fn().mockRejectedValue(new Error("network error")),
      });
      const svc = new FeedbackAttachmentService(repo, storage);
      await expect(svc.addAttachment(makeInput())).rejects.toThrow(
        "network error",
      );
      expect(repo.appendAttachmentKey).not.toHaveBeenCalled();
    });
  });

  describe("Count race (E11)", () => {
    it("removes the just-uploaded key and throws when post-append array exceeds max", async () => {
      // appendAttachmentKey returns an over-length array (race scenario).
      const tooManyKeys = ["k1", "k2", "k3", "k4"]; // length 4 > maxPerReport 3
      const repo = makeFeedbackRepo({
        appendAttachmentKey: vi.fn().mockResolvedValue(tooManyKeys),
      });
      const storage = makeStorage();
      const svc = new FeedbackAttachmentService(repo, storage);

      await expect(svc.addAttachment(makeInput())).rejects.toThrow(
        AttachmentValidationError,
      );
      // The just-uploaded key must be removed.
      expect(storage.remove).toHaveBeenCalledTimes(1);
    });
  });
});

describe("FeedbackAttachmentService.getSignedUrl", () => {
  it("delegates to storage with the default TTL of 60 s", async () => {
    const storage = makeStorage();
    const svc = new FeedbackAttachmentService(makeFeedbackRepo(), storage);
    const url = await svc.getSignedUrl("fb-id/att-id.png");
    expect(storage.createSignedUrl).toHaveBeenCalledWith(
      "fb-id/att-id.png",
      60,
    );
    expect(url).toBe("https://signed.url/test");
  });

  it("passes a custom TTL through to storage", async () => {
    const storage = makeStorage();
    const svc = new FeedbackAttachmentService(makeFeedbackRepo(), storage);
    await svc.getSignedUrl("fb-id/att-id.png", 300);
    expect(storage.createSignedUrl).toHaveBeenCalledWith(
      "fb-id/att-id.png",
      300,
    );
  });
});
