import type { FeedbackRepository } from "@/database/database";
import type { FeedbackCategory } from "@shared/model";
import type { FeedbackMetadata } from "@/database/entities/Feedback";
import { Feedback } from "@/database/entities/Feedback";

export interface FeedbackInput {
  category: FeedbackCategory;
  description: string;
  metadata: FeedbackMetadata | null;
  userId: string | null;
}

export class FeedbackService {
  constructor(private readonly feedbackRepo: FeedbackRepository) {}

  async submitFeedback(input: FeedbackInput): Promise<Feedback> {
    this.validate(input);

    const feedback = new Feedback();
    feedback.category = input.category;
    feedback.description = input.description.trim();
    feedback.metadata = input.metadata;
    feedback.userId = input.userId;

    return this.feedbackRepo.createFeedback(feedback);
  }

  private validate(input: FeedbackInput): void {
    const validCategories: FeedbackCategory[] = [
      "bug",
      "confusing-ux",
      "feature-request",
      "other",
    ];
    if (!validCategories.includes(input.category)) {
      throw new ValidationError("Invalid category");
    }
    const trimmed = input.description?.trim() ?? "";
    if (trimmed.length === 0) {
      throw new ValidationError("Description is required");
    }
    if (trimmed.length > 500) {
      throw new ValidationError("Description must be 500 characters or fewer");
    }
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
