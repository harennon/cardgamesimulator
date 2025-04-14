import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

@Entity()
export class NonceLookup {
    // expecting either a UUID (32 chars) or random base64 transformed 16 Bytes (64 chars)
    @PrimaryColumn("varchar", { length: 64 })
    clientRequestId: string = "";

    // expecting either a UUID (32 chars) or random base64 transformed 16 Bytes (64 chars)
    @Column("varchar", { length: 64 })
    nonce: string = "";

    @CreateDateColumn({type: "timestamptz"})
    createdAt: Date = new Date();
}

@Entity()
export class Account {
    // expecting a UUID, but added more space as buffer
    @PrimaryColumn({ type: "varchar", length: 40, unique: true, update: false })
    accountId: string = "";

    @Column({ type: "varchar", length: 255, unique: true, update: false })
    @Index("username-idx", { unique: true })
    username: string = "";

    @Column("varchar", { length: 255 })
    password: string = "";
}

@Entity()
export class Game {
    // expecting a UUID, but added more space as buffer
    @PrimaryColumn({ type: "varchar", length: 40, unique: true, update: false })
    gameId: string = "";

    @Column("varchar", { length: 255 })
    gameType: string = "";

    @Column({ type: "varchar", length: 40, array: true })
    accountIds: string[] = [];

    @Column({ type: "int" })
    maxPlayers: number = 0;

    // expecting a string literal
    @Column({ type: "varchar", length: 255 })
    status: string = "";

    // variable length string represented game state serialized
    @Column({ type: "varchar" })
    state: string = "{}";
}