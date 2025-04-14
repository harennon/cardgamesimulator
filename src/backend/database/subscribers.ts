import { EntitySubscriberInterface, EventSubscriber, InsertEvent, UpdateEvent } from "typeorm";
import { Game, NonceLookup } from "@/database/entities";
import { PostgresDB } from "@/database/postgres";
import { EventHandler } from "@/api/event";
import { serializeGameForPlayer } from "@/util/serializer";

@EventSubscriber()
export class ExpireOldNonceLookupSubscriber implements EntitySubscriberInterface<NonceLookup> {
    private readonly EXPIRES_AFTER_MINUTE = 300;

    /**
     * Only listens to events for the NonceLookup table.
     */
    listenTo() {
        return NonceLookup;
    }

    /**
     * Called after every insert to NonceLookup table.
     */
    afterInsert(_event: InsertEvent<NonceLookup>): Promise<any> | void {
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() - this.EXPIRES_AFTER_MINUTE);
        return PostgresDB.INSTANCE._deleteExpiredNonceLookup(expiresAt);
    }
}

@EventSubscriber()
export class GameSubscriber implements EntitySubscriberInterface<Game> {
    /**
     * Only listens to updates for the Game table
     */
    listenTo() {
        return Game;
    }

    /**
     * Called after every save to the Game table - typically the following scenarios
     * 1. (Create stage) - new player joined / left
     * 2. (Game stage) - player took turn
     * 
     * Broadcasts event to all players within the game
     */
    async afterUpdate(event: UpdateEvent<Game>) {
        console.log("AfterUpdate event called");
        const gameLiteral = event.entity;
        if (gameLiteral) {
            gameLiteral.accountIds.forEach((accountId: string) => {
                // serialize and sanitize game for each accountId
                const serializedGame = serializeGameForPlayer(gameLiteral, accountId);
                EventHandler.INSTANCE.sendEvent(accountId, serializedGame);
            });
        }
    }
}