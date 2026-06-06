import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

@Entity("player_stats")
export class PlayerStats {
  @PrimaryColumn({ type: "uuid" })
  userId: string = ""; // References Supabase auth.users.id (no FK — different schema)

  @Column({ type: "int", default: 0 })
  gamesPlayed: number = 0;

  @Column({ type: "int", default: 0 })
  gamesWon: number = 0;

  @Column({ type: "int", default: 0 })
  gamesLost: number = 0;

  @Column({ type: "int", default: 0 })
  totalScore: number = 0;

  @UpdateDateColumn({ type: "timestamptz" })
  lastPlayedAt: Date = new Date();
}
