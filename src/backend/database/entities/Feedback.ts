import type { FeedbackCategory } from "@shared/model";

export interface FeedbackMetadata {
  route: string;
  gameId?: string;
  gameStatus?: string;
  gamePhase?: "lobby" | "in-progress" | "game-over";
  userType: "guest" | "registered";
  authState: "authenticated" | "anonymous";
  browser: string;
  viewport: { width: number; height: number };
  timestamp: string;
}

export class Feedback {
  id: string = "";
  category: FeedbackCategory = "other";
  description: string = "";
  metadata: FeedbackMetadata | null = null;
  userId: string | null = null;
  createdAt: Date = new Date();
}
