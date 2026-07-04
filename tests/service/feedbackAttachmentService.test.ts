import { describe, it, expect, vi } from "vitest";
import {
  FeedbackAttachmentService,
  AttachmentValidationError,
  ATTACHMENT_LIMITS,
  type AttachmentInput,
} from "../../src/backend/service/feedbackAttachmentService.js";
import type { AttachmentStorage } from "../../src/backend/service/attachmentStorage.js";
import type { FeedbackRepository } from "../../src/backend/database/database.js";
import { Feedback } from "../../src/backend/database/entities/Feedback.js";
import {
  AccessDeniedError,
  NotFoundError,
} from "../../src/backend/util/errors.js";

// ---------------------------------------------------------------------------
// In-memory doubles
// ---------------------------------------------------------------------------

function makeStorage(
  overrides: Partial<AttachmentStorage> = {},
): AttachmentStorage {
  return {
    upload: vi.fn().mockResolvedValue(undefined),
    createSignedUrl: vi
      .fn()
      .mockResolvedValue("https://signed.example.com/key"),
    remove: vi.fn().mockResolvedValue(undefined),
    removeByPrefix: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeFeedbackRow(overrides: Partial<Feedback> = {}): Feedback {
  const f = new Feedback();
  f.id = "fb-001";
  f.userId = "user-abc";
  f.attachmentKeys = [];
  return Object.assign(f, overrides);
}

function makeRepo(
  row: Feedback | null,
  appendResult: string[] = [],
): FeedbackRepository {
  return {
    createFeedback: vi.fn(),
    getAllFeedback: vi.fn(),
    deleteFeedback: vi.fn(),
    getFeedbackById: vi.fn().mockResolvedValue(row),
    appendAttachmentKey: vi.fn().mockResolvedValue(appendResult),
  };
}

// A minimal valid 1×1 PNG buffer (magic bytes 89 50 4E 47).
function makePngBuffer(extraBytes = 4): Buffer {
  const buf = Buffer.alloc(4 + extraBytes);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  return buf;
}

// A minimal valid JPEG buffer (magic bytes FF D8 FF).
function makeJpegBuffer(): Buffer {
  const buf = Buffer.alloc(8);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  return buf;
}

// A minimal valid WebP buffer (RIFF at 0-3, WEBP at 8-11).
function makeWebpBuffer(): Buffer {
  const buf = Buffer.alloc(16);
  buf[0] = 0x52; // R
  buf[1] = 0x49; // I
  buf[2] = 0x46; // F
  buf[3] = 0x46; // F
  buf[8] = 0x57; // W
  buf[9] = 0x45; // E
  buf[10] = 0x42; // B
  buf[11] = 0x50; // P
  return buf;
}

function makeInput(overrides: Partial<AttachmentInput> = {}): AttachmentInput {
  return {
    feedbackId: "fb-001",
    requesterId: "user-abc",
    isAdmin: false,
    data: makePngBuffer(),
    mimeType: "image/png",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FeedbackAttachmentService.addAttachment", () => {
  // --- E6: ownership / not found ---

  it("throws NotFoundError when getFeedbackById returns null, never calls upload", async () => {
    const storage = makeStorage();
    const repo = makeRepo(null);
    const svc = new FeedbackAttachmentService(repo, storage);

    await expect(svc.addAttachment(makeInput())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("throws AccessDeniedError when row.userId !== requesterId and isAdmin=false", async () => {
    const storage = makeStorage();
    const repo = makeRepo(makeFeedbackRow({ userId: "other-user" }));
    const svc = new FeedbackAttachmentService(repo, storage);

    await expect(
      svc.addAttachment(makeInput({ requesterId: "user-abc", isAdmin: false })),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("allows access when row.userId === requesterId (registered user)", async () => {
    const repo = makeRepo(makeFeedbackRow({ userId: "user-abc" }), ["key"]);
    const svc = new FeedbackAttachmentService(repo, makeStorage());
    await expect(
      svc.addAttachment(makeInput({ requesterId: "user-abc", isAdmin: false })),
    ).resolves.toBeDefined();
  });

  it("allows access when row.userId === requesterId (guest id)", async () => {
    const repo = makeRepo(makeFeedbackRow({ userId: "guest-xyz" }), ["key"]);
    const svc = new FeedbackAttachmentService(repo, makeStorage());
    await expect(
      svc.addAttachment(
        makeInput({ requesterId: "guest-xyz", isAdmin: false }),
      ),
    ).resolves.toBeDefined();
  });

  it("allows access when isAdmin=true regardless of row owner", async () => {
    const repo = makeRepo(makeFeedbackRow({ userId: "someone-else" }), ["key"]);
    const svc = new FeedbackAttachmentService(repo, makeStorage());
    await expect(
      svc.addAttachment(makeInput({ requesterId: "admin-id", isAdmin: true })),
    ).resolves.toBeDefined();
  });

  // --- E3: disallowed MIME type ---

  it("throws AttachmentValidationError for an unknown MIME type", async () => {
    const repo = makeRepo(makeFeedbackRow());
    const svc = new FeedbackAttachmentService(repo, makeStorage());

    await expect(
      svc.addAttachment(makeInput({ mimeType: "image/gif" })),
    ).rejects.toBeInstanceOf(AttachmentValidationError);
  });

  it("throws AttachmentValidationError for a non-image MIME type", async () => {
    const repo = makeRepo(makeFeedbackRow());
    const svc = new FeedbackAttachmentService(repo, makeStorage());

    await expect(
      svc.addAttachment(makeInput({ mimeType: "application/pdf" })),
    ).rejects.toBeInstanceOf(AttachmentValidationError);
  });

  it("accepts image/png, image/jpeg, and image/webp", async () => {
    const cases: [string, Buffer][] = [
      ["image/png", makePngBuffer()],
      ["image/jpeg", makeJpegBuffer()],
      ["image/webp", makeWebpBuffer()],
    ];
    for (const [mime, data] of cases) {
      const repo = makeRepo(makeFeedbackRow(), ["k"]);
      const svc = new FeedbackAttachmentService(repo, makeStorage());
      await expect(
        svc.addAttachment(makeInput({ mimeType: mime, data })),
      ).resolves.toBeDefined();
    }
  });

  // --- E1: file too large ---

  it("throws AttachmentValidationError when decoded size exceeds maxBytesPerFile", async () => {
    const repo = makeRepo(makeFeedbackRow());
    const svc = new FeedbackAttachmentService(repo, makeStorage());
    const oversized = makePngBuffer(ATTACHMENT_LIMITS.maxBytesPerFile + 1);

    await expect(
      svc.addAttachment(makeInput({ data: oversized })),
    ).rejects.toBeInstanceOf(AttachmentValidationError);
  });

  // --- E10: zero-byte ---

  it("throws AttachmentValidationError for a zero-byte buffer", async () => {
    const repo = makeRepo(makeFeedbackRow());
    const svc = new FeedbackAttachmentService(repo, makeStorage());

    await expect(
      svc.addAttachment(makeInput({ data: Buffer.alloc(0) })),
    ).rejects.toBeInstanceOf(AttachmentValidationError);
  });

  // --- E4: magic-byte mismatch ---

  it("throws AttachmentValidationError when magic bytes do not match declared MIME type", async () => {
    const repo = makeRepo(makeFeedbackRow());
    const svc = new FeedbackAttachmentService(repo, makeStorage());

    // PNG data but declared as JPEG
    await expect(
      svc.addAttachment(
        makeInput({ data: makePngBuffer(), mimeType: "image/jpeg" }),
      ),
    ).rejects.toBeInstanceOf(AttachmentValidationError);
  });

  it("throws AttachmentValidationError when magic bytes do not match for WebP (RIFF container)", async () => {
    const repo = makeRepo(makeFeedbackRow());
    const svc = new FeedbackAttachmentService(repo, makeStorage());

    // JPEG data but declared as WebP
    await expect(
      svc.addAttachment(
        makeInput({ data: makeJpegBuffer(), mimeType: "image/webp" }),
      ),
    ).rejects.toBeInstanceOf(AttachmentValidationError);
  });

  it("accepts valid WebP RIFF container buffer", async () => {
    const repo = makeRepo(makeFeedbackRow(), ["k"]);
    const svc = new FeedbackAttachmentService(repo, makeStorage());
    await expect(
      svc.addAttachment(
        makeInput({ data: makeWebpBuffer(), mimeType: "image/webp" }),
      ),
    ).resolves.toBeDefined();
  });

  // --- E2: too many attachments ---

  it("throws AttachmentValidationError when row already has maxPerReport keys", async () => {
    const full = makeFeedbackRow({
      attachmentKeys: ["k1", "k2", "k3"],
    });
    const repo = makeRepo(full);
    const svc = new FeedbackAttachmentService(repo, makeStorage());

    await expect(svc.addAttachment(makeInput())).rejects.toBeInstanceOf(
      AttachmentValidationError,
    );
  });

  // --- happy path: correct key shape and repo calls ---

  it("calls storage.upload with key {feedbackId}/{uuid}.{ext} and appends that key", async () => {
    const storage = makeStorage();
    const repo = makeRepo(makeFeedbackRow(), ["expected-key"]);
    const svc = new FeedbackAttachmentService(repo, storage);
    const input = makeInput();

    const result = await svc.addAttachment(input);

    expect(storage.upload).toHaveBeenCalledOnce();
    const [calledKey, calledData, calledMime] = (
      storage.upload as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, Buffer, string];
    expect(calledKey).toMatch(/^fb-001\/[0-9a-f-]{36}\.png$/);
    expect(calledData).toStrictEqual(input.data);
    expect(calledMime).toBe("image/png");

    expect(repo.appendAttachmentKey).toHaveBeenCalledWith("fb-001", calledKey);
    expect(result.key).toBe(calledKey);
    expect(result.attachmentId).toBeTruthy();
  });

  // --- E7: storage upload fails → no key appended ---

  it("does not append a key when storage.upload rejects", async () => {
    const storage = makeStorage({
      upload: vi.fn().mockRejectedValue(new Error("network")),
    });
    const repo = makeRepo(makeFeedbackRow());
    const svc = new FeedbackAttachmentService(repo, storage);

    await expect(svc.addAttachment(makeInput())).rejects.toThrow("network");
    expect(repo.appendAttachmentKey).not.toHaveBeenCalled();
  });

  it("removes just-uploaded object (via storage.remove) when appendAttachmentKey throws (E7 orphan prevention)", async () => {
    const storage = makeStorage();
    const appendError = new Error("db error");
    const repo: FeedbackRepository = {
      createFeedback: vi.fn(),
      getAllFeedback: vi.fn(),
      deleteFeedback: vi.fn(),
      getFeedbackById: vi.fn().mockResolvedValue(makeFeedbackRow()),
      appendAttachmentKey: vi.fn().mockRejectedValue(appendError),
    };
    const svc = new FeedbackAttachmentService(repo, storage);

    await expect(svc.addAttachment(makeInput())).rejects.toThrow("db error");

    // Upload succeeded, so cleanup must happen via exact-key delete (not removeByPrefix).
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(storage.remove).toHaveBeenCalledOnce();
    expect(storage.removeByPrefix).not.toHaveBeenCalled();

    // The key passed to remove must match the key that was uploaded.
    const uploadedKey = (storage.upload as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    const removedKey = (storage.remove as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(removedKey).toBe(uploadedKey);
    expect(removedKey).toMatch(/^fb-001\/[0-9a-f-]{36}\.png$/);
  });

  // --- E11: concurrent append race ---

  it("removes the just-uploaded object and throws when appendAttachmentKey returns over-length array", async () => {
    const storage = makeStorage();
    const overLengthKeys = ["k1", "k2", "k3", "k4"]; // 4 > maxPerReport=3
    const repo = makeRepo(makeFeedbackRow(), overLengthKeys);
    const svc = new FeedbackAttachmentService(repo, storage);

    await expect(svc.addAttachment(makeInput())).rejects.toBeInstanceOf(
      AttachmentValidationError,
    );
    // Must use exact-key delete (storage.remove), NOT removeByPrefix which
    // treats its arg as a folder prefix and would list an empty folder.
    expect(storage.remove).toHaveBeenCalledOnce();
    expect(storage.removeByPrefix).not.toHaveBeenCalled();
    const removedKey = (storage.remove as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(removedKey).toMatch(/^fb-001\/[0-9a-f-]{36}\.png$/);
  });
});

describe("FeedbackAttachmentService.getSignedUrl", () => {
  it("delegates to storage with the expected TTL (default 60 s)", async () => {
    const storage = makeStorage();
    const svc = new FeedbackAttachmentService(makeRepo(null), storage);

    const url = await svc.getSignedUrl("some/key");
    expect(storage.createSignedUrl).toHaveBeenCalledWith("some/key", 60);
    expect(url).toBe("https://signed.example.com/key");
  });

  it("passes a custom TTL to storage", async () => {
    const storage = makeStorage();
    const svc = new FeedbackAttachmentService(makeRepo(null), storage);

    await svc.getSignedUrl("some/key", 300);
    expect(storage.createSignedUrl).toHaveBeenCalledWith("some/key", 300);
  });
});
