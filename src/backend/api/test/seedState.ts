import { Router, type Request, type Response } from "express";
import type { GameCache } from "@/engine/game-cache";
import type { GameRepository } from "@/database/database";
import type { InternalGameState, GameStatus } from "@shared/engine-types";

export interface SeedStateRequest {
  gameId: string;
  state: Partial<InternalGameState>;
  dbFields?: {
    status?: GameStatus;
    playerIds?: string[];
    playerDisplayNames?: Record<string, string>;
    maxPlayers?: number;
    turnTimerSeconds?: number | null;
  };
}

export interface SeedStateResponse {
  success: boolean;
  gameId: string;
}

/**
 * POST /test/seed-state
 * Seeds the game cache and optionally updates the DB record.
 * Only available when NODE_ENV=test (checked both at registration and inside handler).
 */
export function createSeedStateRouter(
  gameCache: GameCache,
  gameRepo: GameRepository,
): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    // Belt-and-suspenders: refuse to operate if not in test mode
    if (process.env.NODE_ENV !== "test") {
      res.status(403).json({ success: false, error: "Forbidden" });
      return;
    }

    const { gameId, state, dbFields } = req.body as SeedStateRequest;

    if (!gameId) {
      res.status(400).json({ success: false, error: "gameId is required" });
      return;
    }

    const game = await gameRepo.getGame(gameId);
    if (!game) {
      res.status(404).json({ success: false, error: "Game not found" });
      return;
    }

    // Apply DB field overrides if provided
    if (dbFields) {
      if (dbFields.status !== undefined) game.status = dbFields.status;
      if (dbFields.playerIds !== undefined) game.playerIds = dbFields.playerIds;
      if (dbFields.playerDisplayNames !== undefined)
        game.playerDisplayNames = dbFields.playerDisplayNames;
      if (dbFields.maxPlayers !== undefined)
        game.maxPlayers = dbFields.maxPlayers;
      if (dbFields.turnTimerSeconds !== undefined)
        game.turnTimerSeconds = dbFields.turnTimerSeconds;
    }

    // Merge provided state with any current cache state
    const currentState = gameCache.get(gameId);
    const mergedState: InternalGameState = {
      ...(currentState ?? ({} as InternalGameState)),
      ...state,
      gameId,
    } as InternalGameState;

    // If state has a status, sync DB status
    if (state.status) {
      game.status = state.status;
    }

    game.state = mergedState as unknown as Record<string, unknown>;

    // Save to DB (game is version-tracked — save what we loaded)
    await gameRepo.saveGame(game);

    // Write to cache (set marks as clean)
    gameCache.set(gameId, mergedState);

    const response: SeedStateResponse = { success: true, gameId };
    res.status(200).json(response);
  });

  return router;
}
