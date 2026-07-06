import express, { type Request as ExpressRequest } from "express";
import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import type {
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
  SubmitAttachmentRequest,
  SubmitAttachmentResponse,
  AdminFeedbackEntry,
} from "@shared/model";
import { FeedbackService, ValidationError } from "@/service/feedbackService";
import {
  FeedbackAttachmentService,
  AttachmentValidationError,
} from "@/service/feedbackAttachmentService";
import { SupabaseAttachmentStorage } from "@/service/attachmentStorage";
import { SupabaseDB } from "@/database/supabaseDb";
import { feedbackRepo } from "@/database";
import { NotFoundError, AccessDeniedError } from "@/util/errors";

// ~7 MB limit on the attachment route: 5 MB payload + ~33% base64 inflation.
// The global express.json() 100 kB limit must NOT be raised globally.
const ATTACHMENT_BODY_LIMIT = "7mb";

function getAdminIds(): Set<string> {
  return new Set(
    (process.env.FEEDBACK_ADMIN_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export class FeedbackHandler extends Handler {
  public static INSTANCE: FeedbackHandler = new FeedbackHandler();
  private readonly feedbackService: FeedbackService;
  private readonly attachmentService: FeedbackAttachmentService;

  private constructor() {
    super();
    this.feedbackService = new FeedbackService(feedbackRepo);

    const storage = new SupabaseAttachmentStorage(
      () => SupabaseDB.INSTANCE.storageClient,
    );
    this.attachmentService = new FeedbackAttachmentService(
      feedbackRepo,
      storage,
    );

    this.router.delete("/:id", async (req, res) => this.delete(req, res));

    // Attachment route: dedicated body-parser to allow ~7 MB base64 payloads
    // without raising the global limit.
    this.router.post(
      "/:id/attachments",
      express.json({ limit: ATTACHMENT_BODY_LIMIT }),
      async (req: ExpressRequest, res) =>
        this.postAttachment(req as Request, res as Response),
    );
  }

  public override async get(
    request: Request,
    response: Response<AdminFeedbackEntry[] | { error: string }>,
  ) {
    const userId = request.userId;
    if (!userId || !getAdminIds().has(userId)) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    const feedback = await feedbackRepo.getAllFeedback();

    const entries = await Promise.all(
      feedback.map(async (f) => {
        const attachments = await Promise.all(
          f.attachmentKeys.map((key) =>
            this.attachmentService.getSignedUrl(key),
          ),
        );
        return {
          id: f.id,
          category: f.category,
          description: f.description,
          metadata: f.metadata,
          userId: f.userId,
          createdAt: f.createdAt.toISOString(),
          attachmentKeys: f.attachmentKeys,
          attachments,
        };
      }),
    );

    response.status(200).json(entries);
  }

  public async delete(request: Request, response: Response) {
    const userId = request.userId;
    if (!userId || !getAdminIds().has(userId)) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    const { id } = request.params;

    // Objects FIRST — if this throws the row is left intact for retry.
    const row = await feedbackRepo.getFeedbackById(id);
    if (!row) {
      response.status(404).json({ error: "Feedback not found" });
      return;
    }

    await this.attachmentService.removeStoragePrefix(id);

    const deleted = await feedbackRepo.deleteFeedback(id);
    if (!deleted) {
      response.status(404).json({ error: "Feedback not found" });
      return;
    }

    response.status(200).json({ deleted: id });
  }

  public override async post(
    request: Request,
    response: Response<SubmitFeedbackResponse | { error: string }>,
  ) {
    const body = request.body as SubmitFeedbackRequest & { metadata?: unknown };
    const userId = request.userId ?? null;

    try {
      const feedback = await this.feedbackService.submitFeedback({
        category: body.category,
        description: body.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: (body.metadata as any) ?? null,
        userId,
      });

      response.status(201).json({
        id: feedback.id,
        createdAt: feedback.createdAt.toISOString(),
      });
    } catch (err: unknown) {
      if (err instanceof ValidationError) {
        response.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  }

  public async postAttachment(
    request: Request,
    response: Response<SubmitAttachmentResponse | { error: string }>,
  ) {
    const userId = request.userId;
    if (!userId) {
      // authMiddleware should have thrown before reaching here, but guard anyway.
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { id } = request.params;
    const body = request.body as SubmitAttachmentRequest;

    // Decode base64 (E5: missing, non-string, or zero-length decode).
    // Note: Buffer.from(str, 'base64') never throws — it silently drops
    // invalid characters. The empty-length guard below catches the
    // fully-invalid input case. Truly malformed (non-empty) base64 passes
    // here and is rejected downstream by the magic-byte check (E4).
    let imageBuffer: Buffer;
    try {
      if (!body.image || typeof body.image !== "string") {
        throw new Error("missing");
      }
      imageBuffer = Buffer.from(body.image, "base64");
      if (imageBuffer.length === 0) throw new Error("empty");
    } catch {
      response.status(400).json({ error: "Invalid image data" });
      return;
    }

    try {
      const result = await this.attachmentService.addAttachment({
        feedbackId: id,
        requesterId: userId,
        isAdmin: getAdminIds().has(userId),
        data: imageBuffer,
        mimeType: body.mimeType,
      });

      response.status(201).json(result);
    } catch (err: unknown) {
      if (err instanceof AttachmentValidationError) {
        response.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof NotFoundError) {
        response.status(404).json({ error: "Feedback not found" });
        return;
      }
      if (err instanceof AccessDeniedError) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }
      throw err;
    }
  }
}
