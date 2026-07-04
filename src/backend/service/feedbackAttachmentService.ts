import { randomUUID } from "crypto";
import type { FeedbackRepository } from "@/database/database";
import type { AttachmentStorage } from "./attachmentStorage";
import { NotFoundError, AccessDeniedError } from "@/util/errors";

export interface AttachmentInput {
  feedbackId: string;
  requesterId: string;
  isAdmin: boolean;
  data: Buffer;
  mimeType: string;
}

export interface AttachmentResult {
  attachmentId: string;
  key: string;
}

export const ATTACHMENT_LIMITS = {
  maxBytesPerFile: 5 * 1024 * 1024,
  maxPerReport: 3,
  allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
} as const;

export class AttachmentValidationError extends Error {
  public readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
    Object.setPrototypeOf(this, AttachmentValidationError.prototype);
  }
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Sniffs magic bytes to verify the actual format matches the declared mimeType.
 * PNG: 89 50 4E 47 | JPEG: FF D8 FF | WebP: RIFF....WEBP (offsets 0 and 8)
 */
function magicBytesMatch(data: Buffer, mimeType: string): boolean {
  if (data.length < 4) return false;
  switch (mimeType) {
    case "image/png":
      return (
        data[0] === 0x89 &&
        data[1] === 0x50 &&
        data[2] === 0x4e &&
        data[3] === 0x47
      );
    case "image/jpeg":
      return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case "image/webp":
      if (data.length < 12) return false;
      return (
        data[0] === 0x52 &&
        data[1] === 0x49 &&
        data[2] === 0x46 &&
        data[3] === 0x46 &&
        data[8] === 0x57 &&
        data[9] === 0x45 &&
        data[10] === 0x42 &&
        data[11] === 0x50
      );
    default:
      return false;
  }
}

export class FeedbackAttachmentService {
  constructor(
    private readonly feedbackRepo: FeedbackRepository,
    private readonly storage: AttachmentStorage,
  ) {}

  /**
   * Validates and uploads one attachment, linking its key to the feedback row.
   * Ordered fail-closed: security checks first, upload last.
   */
  async addAttachment(input: AttachmentInput): Promise<AttachmentResult> {
    // 1. Ownership resolution — 404 if absent (no info leak on existence).
    const row = await this.feedbackRepo.getFeedbackById(input.feedbackId);
    if (!row) throw new NotFoundError();

    // 2. Ownership: caller must own the row or be admin.
    if (!input.isAdmin && row.userId !== input.requesterId) {
      throw new AccessDeniedError();
    }

    // 3. Validate mime (E3).
    if (
      !(ATTACHMENT_LIMITS.allowedMimeTypes as readonly string[]).includes(
        input.mimeType,
      )
    ) {
      throw new AttachmentValidationError(
        `Unsupported mime type: ${input.mimeType}`,
      );
    }

    // 4. Validate size (E1 / E10).
    if (input.data.length === 0) {
      throw new AttachmentValidationError("Invalid image data");
    }
    if (input.data.length > ATTACHMENT_LIMITS.maxBytesPerFile) {
      throw new AttachmentValidationError("File too large");
    }

    // 5. Magic-byte cross-check (E4).
    if (!magicBytesMatch(input.data, input.mimeType)) {
      throw new AttachmentValidationError(
        "Declared mime type does not match image data",
      );
    }

    // 6. Pre-upload count guard (E2) — authoritative guard is post-append (E11).
    if (row.attachmentKeys.length >= ATTACHMENT_LIMITS.maxPerReport) {
      throw new AttachmentValidationError("Too many attachments");
    }

    // 7. Upload (E7: if this throws, no key is appended).
    const attachmentId = randomUUID();
    const ext = MIME_TO_EXT[input.mimeType];
    const key = `${input.feedbackId}/${attachmentId}.${ext}`;

    await this.storage.upload(key, input.data, input.mimeType);

    // 8. Atomic append — returns the post-append array (closes E11 race).
    let updatedKeys: string[];
    try {
      updatedKeys = await this.feedbackRepo.appendAttachmentKey(
        input.feedbackId,
        key,
      );
    } catch (err) {
      // Append failed — remove the object so we don't leave a dangling blob.
      await this.storage.remove(key).catch(() => undefined);
      throw err;
    }

    // 9. Post-append cap enforcement (E11).
    if (updatedKeys.length > ATTACHMENT_LIMITS.maxPerReport) {
      await this.storage.remove(key).catch(() => undefined);
      throw new AttachmentValidationError("Too many attachments");
    }

    return { attachmentId, key };
  }

  /** Issues a short-lived signed read URL. Default TTL: 60 s. */
  async getSignedUrl(key: string, ttlSeconds = 60): Promise<string> {
    return this.storage.createSignedUrl(key, ttlSeconds);
  }

  /** Idempotent: removes all Storage objects under the feedback-id prefix. */
  async removeStoragePrefix(feedbackId: string): Promise<void> {
    return this.storage.removeByPrefix(feedbackId);
  }
}
