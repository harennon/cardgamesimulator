import { DataSource, In, QueryFailedError, type Repository } from "typeorm";
import { v4 as uuidv4 } from "uuid";
import { DatabaseError } from "pg-protocol";

import { Database } from "@/database/database";
import { Account, Game, NonceLookup } from "@/database/entities";
import { DeleteResult } from "typeorm/browser";
import { ExpireOldNonceLookupSubscriber, GameSubscriber } from "@/database/subscribers";
import { AlreadyExistsError } from "@/util/errors";
import { GameStatus, GameType } from "@shared/model";

export const isQueryFailedError = (error: unknown): error is QueryFailedError & DatabaseError =>
    error instanceof QueryFailedError;

export class PostgresDB implements Database {
    public static readonly INSTANCE = new PostgresDB();

    private dataSource: DataSource | undefined = undefined;

    private constructor() { }

    public async initialize(): Promise<void> {
        if (this.dataSource != undefined) {
            throw new Error("Database already initialized");
        }
        const postgresDataSource = new DataSource({
            type: "postgres",
            host: "database",
            port: Number.parseInt(process.env.POSTGRES_PORT || '5432'),
            username: process.env.POSTGRES_USER,
            password: process.env.POSTGRES_PASSWORD,
            entities: [NonceLookup, Account, Game],
            subscribers: [ExpireOldNonceLookupSubscriber, GameSubscriber],
            synchronize: true,
            logging: "all",
        });

        this.dataSource = await postgresDataSource.initialize();
    }

    public async saveNonce(clientId: string, nonce: string): Promise<void> {
        const nonceLookup = new NonceLookup()
        nonceLookup.clientRequestId = clientId;
        nonceLookup.nonce = nonce;
        await this.dataSource!.getRepository(NonceLookup).save(nonceLookup);
    }

    public async getAndRemoveNonce(clientId: string): Promise<string> {
        const table: Repository<NonceLookup> = this.dataSource!.getRepository(NonceLookup);
        const nonceLookup = await table.findOneByOrFail({
            clientRequestId: clientId,
        }).then((returnedItem) => {
            // remove returned item
            table.remove(returnedItem);
            return returnedItem;
        });
        return nonceLookup.nonce;
    }

    /**
     * **INTERNAL METHOD**
     * Used by NonceLookup subscriber to delete old entries]
     * 
     * @param expiresAt - Oldest date from which all previous items are removed
     */
    public async _deleteExpiredNonceLookup(expiresAt: Date): Promise<DeleteResult> {
        return await this.dataSource!
            .createQueryBuilder()
            .delete()
            .from(NonceLookup)
            .where("createdAt <= :expiresAt", { expiresAt: expiresAt })
            .execute();
    }

    public async createAccount(username: string, password: string): Promise<Account> {
        const account = new Account();
        account.accountId = uuidv4();
        account.username = username;
        account.password = password;

        await this.dataSource!.getRepository(Account).save(account).catch((err) => {
            if (isQueryFailedError(err)) {
                // unique violation
                if (err.code === "23505") {
                    throw new AlreadyExistsError();
                }
            }
        });
        return account;
    }

    public async getAccount(username: string): Promise<Account | null> {
        return await this.dataSource!.getRepository(Account).findOneBy({
            username: username,
        });
    }

    public async getAccountById(accountId: string): Promise<Account | null> {
        return await this.dataSource!.getRepository(Account).findOneBy({
            accountId: accountId,
        });
    }

    public async getAccountsByIds(accountIds: string[]): Promise<Account[]> {
        return await this.dataSource!.getRepository(Account).findBy({
            accountId: In(accountIds),
        });
    }

    public async createGame(gameType: GameType, accountId: string, maxPlayers: number): Promise<Game> {
        const game = new Game();
        game.gameId = uuidv4();
        game.gameType = gameType,
            game.accountIds = [accountId];
        game.maxPlayers = maxPlayers;
        game.status = "CREATED" as GameStatus;

        // TODO: change to create and update subscribers to triggers on database level
        return this.dataSource!.getRepository(Game).save(game);
    }

    public async getGame(gameId: string): Promise<Game | null> {
        return await this.dataSource!.getRepository(Game).findOneBy({
            gameId: gameId,
        });
    }

    public async saveGame(game: Game): Promise<null> {
        // TODO: change to update and update subscribers to triggers on database level
        return this.dataSource!.getRepository(Game).save(game).then(() => {
            return new Promise<null>((resolve, _reject) => resolve(null));
        });
    }
}