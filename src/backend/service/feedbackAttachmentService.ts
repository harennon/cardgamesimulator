import { randomUUID } from "crypto";
import type { FeedbackRepository } from "@/database/database";
import { AccessDeniedError, NotFoundError } from "@/util/errors";
import type { AttachmentStorage } from "./attachmentStorage";

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
  maxBytesPerFile: 5 * 1024 * 1024, // 5 MB
  maxPerReport: 3,
  allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
} as const;

// GIF is intentionally excluded: screenshot-attach use case; every platform
// screenshot tool emits PNG/JPEG/WebP. Excluding GIF narrows the accepted
// surface and avoids animated-GIF payload concerns.

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Validate magic bytes against declared MIME type. Returns true if they match. */
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
      // RIFF container: bytes 0-3 = "RIFF", bytes 8-11 = "WEBP"
      return (
        data.length >= 12 &&
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

export class AttachmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

export class FeedbackAttachmentService {
  constructor(
    private readonly feedbackRepo: FeedbackRepository,
    private readonly storage: AttachmentStorage,
  ) {}

  async addAttachment(input: AttachmentInput): Promise<AttachmentResult> {
    // 1. Load row; not found → NotFoundError.
    const row = await this.feedbackRepo.getFeedbackById(input.feedbackId);
    if (!row) throw new NotFoundError();

    // 2. Ownership check.
    if (!input.isAdmin && row.userId !== input.requesterId) {
      throw new AccessDeniedError();
    }

    // 3a. MIME type allowed.
    if (
      !(ATTACHMENT_LIMITS.allowedMimeTypes as readonly string[]).includes(
        input.mimeType,
      )
    ) {
      throw new AttachmentValidationError(
        `Unsupported MIME type: ${input.mimeType}`,
      );
    }

    // 3b. Size checks.
    if (input.data.length === 0) {
      throw new AttachmentValidationError("Image data is empty");
    }
    if (input.data.length > ATTACHMENT_LIMITS.maxBytesPerFile) {
      throw new AttachmentValidationError(
        `Image exceeds the ${ATTACHMENT_LIMITS.maxBytesPerFile} byte limit`,
      );
    }

    // 3c. Magic-byte sniff.
    if (!magicBytesMatch(input.data, input.mimeType)) {
      throw new AttachmentValidationError(
        "Image data does not match declared MIME type",
      );
    }

    // 3d. Pre-upload count check (cheap early exit for the common case).
    if (row.attachmentKeys.length >= ATTACHMENT_LIMITS.maxPerReport) {
      throw new AttachmentValidationError(
        `Maximum ${ATTACHMENT_LIMITS.maxPerReport} attachments per report`,
      );
    }

    // 4. Upload buffer (no key appended if this throws — E7).
    const attachmentId = randomUUID();
    const ext = MIME_EXT[input.mimeType]!;
    const key = `${input.feedbackId}/${attachmentId}.${ext}`;
    await this.storage.upload(key, input.data, input.mimeType);

    // 5. Append key; enforce post-append length (E11 race guard).
    let updatedKeys: string[];
    try {
      updatedKeys = await this.feedbackRepo.appendAttachmentKey(
        input.feedbackId,
        key,
      );
    } catch (err) {
      // Cleanup the uploaded object so no orphan remains.
      await this.storage.removeByPrefix(key).catch(() => undefined);
      throw err;
    }

    if (updatedKeys.length > ATTACHMENT_LIMITS.maxPerReport) {
      // Concurrent append raced past the cap — remove the object we just added.
      await this.storage.removeByPrefix(key).catch(() => undefined);
      throw new AttachmentValidationError(
        `Maximum ${ATTACHMENT_LIMITS.maxPerReport} attachments per report`,
      );
    }

    return { attachmentId, key };
  }

  async getSignedUrl(key: string, ttlSeconds = 60): Promise<string> {
    return this.storage.createSignedUrl(key, ttlSeconds);
  }

  /**
   * Delete all storage objects under the feedback-attachments/{feedbackId}/ prefix.
   * Called by the delete handler before the DB row is deleted (retention policy).
   * Idempotent — a no-op if no objects exist.
   */
  async removeStoragePrefix(feedbackId: string): Promise<void> {
    await this.storage.removeByPrefix(feedbackId);
  }
}
