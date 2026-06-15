import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import type {
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
} from "@shared/model";
import { FeedbackService, ValidationError } from "@/service/feedbackService";
import { feedbackRepo } from "@/database";

export class SubmitFeedbackHandler extends Handler {
  public static INSTANCE: SubmitFeedbackHandler = new SubmitFeedbackHandler();
  private readonly feedbackService: FeedbackService;

  private constructor() {
    super();
    this.feedbackService = new FeedbackService(feedbackRepo);
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
