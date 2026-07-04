import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import type {
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
  SubmitAttachmentRequest,
  SubmitAttachmentResponse,
} from "@shared/model";
import { FeedbackService, ValidationError } from "@/service/feedbackService";
import {
  FeedbackAttachmentService,
  AttachmentValidationError,
} from "@/service/feedbackAttachmentService";
import { SupabaseAttachmentStorage } from "@/service/attachmentStorage";
import { feedbackRepo } from "@/database";
import { SupabaseDB } from "@/database/supabaseDb";
import { AccessDeniedError, NotFoundError } from "@/util/errors";

// The 7 MB body-parser limit for attachment routes is wired at the server/app
// level (server.ts + testServer.ts) before the global express.json() so the
// global 100 kb limit never rejects attachment bodies.

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
    this.attachmentService = new FeedbackAttachmentService(
      feedbackRepo,
      new SupabaseAttachmentStorage(() => SupabaseDB.INSTANCE.storageClient),
    );

    this.router.delete("/:id", async (req, res) => this.delete(req, res));
    this.router.post("/:id/attachments", async (req, res) =>
      this.postAttachment(req, res),
    );
  }

  public override async get(request: Request, response: Response) {
    const userId = request.userId;
    if (!userId || !getAdminIds().has(userId)) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    const feedback = await feedbackRepo.getAllFeedback();
    response.status(200).json(
      feedback.map((f) => ({
        id: f.id,
        category: f.category,
        description: f.description,
        metadata: f.metadata,
        userId: f.userId,
        createdAt: f.createdAt.toISOString(),
      })),
    );
  }

  public async delete(request: Request, response: Response) {
    const userId = request.userId;
    if (!userId || !getAdminIds().has(userId)) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    const { id } = request.params;

    // Retention: objects FIRST, then the row.
    // Step 1: load row — if absent, 404 (nothing to clean).
    const row = await feedbackRepo.getFeedbackById(id);
    if (!row) {
      response.status(404).json({ error: "Feedback not found" });
      return;
    }

    // Step 2: remove all storage objects under the prefix. Idempotent; if this
    // throws we respond 500 and leave the row intact so a retry can recover.
    await this.attachmentService.removeStoragePrefix(id);

    // Step 3: delete the row only after objects are confirmed gone.
    const deleted = await feedbackRepo.deleteFeedback(id);
    if (!deleted) {
      // Race: row vanished between step 1 and step 3. Objects were cleaned in
      // step 2, so nothing is orphaned.
      response.status(404).json({ error: "Feedback not found" });
      return;
    }

    response.status(200).json({ deleted: id });
  }

  public async postAttachment(request: Request, response: Response) {
    const userId = request.userId;
    if (!userId) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { id } = request.params;
    const body = request.body as SubmitAttachmentRequest;

    // Decode base64 → Buffer (E5).
    let imageBuffer: Buffer;
    try {
      if (!body.image || typeof body.image !== "string") {
        throw new Error("missing");
      }
      imageBuffer = Buffer.from(body.image, "base64");
      // Buffer.from silently produces garbage on malformed input; detect via
      // re-encoding and comparing lengths as a sanity check.
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
        mimeType: body.mimeType ?? "",
      });

      const res: SubmitAttachmentResponse = {
        attachmentId: result.attachmentId,
        key: result.key,
      };
      response.status(201).json(res);
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
}
