import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from "typeorm";
import type { FeedbackCategory } from "@shared/model";

export interface FeedbackMetadata {
  route: string;
  gameId?: string;
  gameStatus?: string;
  userType: "guest" | "registered";
  browser: string;
  viewport: { width: number; height: number };
  timestamp: string;
}

@Entity("feedback")
export class Feedback {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 20 })
  category: FeedbackCategory = "other";

  @Column({ type: "varchar", length: 500 })
  description: string = "";

  @Column({ type: "jsonb", nullable: true })
  metadata: FeedbackMetadata | null = null;

  @Column({ type: "uuid", nullable: true })
  userId: string | null = null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
