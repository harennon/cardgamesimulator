import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
} from "typeorm";

import type { GameType, GameStatus } from "@shared/engine-types";

@Entity("games")
export class Game {
  @PrimaryColumn({ type: "uuid" })
  gameId: string = "";

  @Column({ type: "varchar", length: 50 })
  gameType: GameType = "big2";

  @Column({ type: "uuid", array: true, default: "{}" })
  playerIds: string[] = [];

  @Column({ type: "jsonb", default: "{}" })
  playerDisplayNames: Record<string, string> = {};

  @Column({ type: "int" })
  maxPlayers: number = 4;

  @Column({ type: "varchar", length: 20 })
  status: GameStatus = "CREATED";

  @Column({ type: "jsonb", default: "{}" })
  state: Record<string, unknown> = {};

  @Column({ type: "int", nullable: true, default: null })
  turnTimerSeconds: number | null = null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date = new Date();

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date = new Date();

  @VersionColumn()
  version: number = 1;
}
