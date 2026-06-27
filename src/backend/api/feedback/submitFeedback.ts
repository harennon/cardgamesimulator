import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import type {
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
} from "@shared/model";
import { FeedbackService, ValidationError } from "@/service/feedbackService";
import { feedbackRepo } from "@/database";

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

  private constructor() {
    super();
    this.feedbackService = new FeedbackService(feedbackRepo);
    this.router.delete("/:id", async (req, res) => this.delete(req, res));
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
}
