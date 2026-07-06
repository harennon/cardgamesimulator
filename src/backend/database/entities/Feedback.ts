import type { FeedbackCategory, FeedbackMetadata } from "@shared/model";

export type { FeedbackMetadata };

export class Feedback {
  id: string = "";
  category: FeedbackCategory = "other";
  description: string = "";
  metadata: FeedbackMetadata | null = null;
  userId: string | null = null;
  createdAt: Date = new Date();
  attachmentKeys: string[] = [];
}
