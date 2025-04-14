import { GameType } from "@shared/model";

/**
 * Storage interface to store / query information for games and players
 */
export interface Database {
    /**
     * initialize all tables
     */
    initialize(): Promise<unknown>;

    /**
     * =================================================================
     * AUTH METHODS
     * =================================================================
     */

    /**
     * **USED FOR AUTH**
     * Correlates client specified Id with generated nonce. Nonces are
     * generated and removed per login request.
     * 
     * Saved nonce expire after a set time in case client never attempted
     * to login after getting it.
     * 
     * @param clientId - client specified requestId to correlate with nonce.
     *  should be unique per login attempt.
     * @param nonce - server generated nonce to correlate with clientId.
     */
    saveNonce(clientId: string, nonce: string): Promise<void>;

    /**
     * **USED FOR AUTH**
     * Gets and removes nonce for specified client request id. Nonces should
     * only ever used once per login request.
     * 
     * @param clientId - client specified requestId to correlate with nonce.
     *  should be unique per login attempt.
     * @returns nonce
     */
    getAndRemoveNonce(clientId: string): Promise<string>;

    /**
     * **USED FOR AUTH**
     * Creates an account given the username and password
     * If the specified username conflicts with existing entry, an exception
     * will be raised.
     * 
     * @param username - client specified username
     * @param password - (hopefully hashed + salted) client password
     */
    createAccount(username: string, password: string): Promise<unknown>;

    /**
     * **USED FOR AUTH**
     * Gets an account given the username if exists.
     * 
     * @param username - client specified username
     * @returns account if exists
     */
    getAccount(username: string): Promise<unknown>;

    /**
     * Gets an account given the accountId if exists
     * 
     * @param accountId - accountId
     * @returns account if exists
     */
    getAccountById(accountId: string): Promise<unknown>;

    /**
     * =================================================================
     * Game methods
     * =================================================================
     */

    /**
     * Create a game
     */
    createGame(gameType: GameType, accountId: string, maxPlayers: number): Promise<unknown>;

    /**
     * Get a game given the id if exists.
     * 
     * @param gameId - client given gameId
     * @returns game if exists
     */
    getGame(gameId: string): Promise<unknown>;

    /**
     * Save a specified game state to the database.
     * 
     * @param game - specified game
     */
    saveGame(game: any): Promise<unknown>;
}