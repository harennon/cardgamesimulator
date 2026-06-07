import express, { type Router } from "express";
import type { Request, Response } from "@/util/types";
import type { GameRepository } from "@/database/database";
import { verifyGuestToken } from "@/guest/guestToken";
import { BadRequestError } from "@/util/errors";
import type {
  ClaimGuestSessionRequest,
  ClaimGuestSessionResponse,
} from "@shared/guest-types";

export function createClaimRouter(gameRepo: GameRepository): Router {
  const router = express.Router();

  router.post(
    "/",
    async (
      req: Request<ClaimGuestSessionRequest>,
      res: Response<ClaimGuestSessionResponse>,
    ) => {
      const newUserId = req.userId!;
      const { guestToken } = req.body;

      if (!guestToken || typeof guestToken !== "string") {
        throw new BadRequestError();
      }

      const jwtSecret = process.env.SUPABASE_JWT_SECRET!;
      const payload = verifyGuestToken(guestToken, jwtSecret);
      if (!payload) {
        // Expired or invalid guest token — treat as 0 games linked (not an error)
        const response: ClaimGuestSessionResponse = {
          success: true,
          gamesLinked: 0,
        };
        res.status(200).json(response);
        return;
      }

      const { guestId } = payload;

      // Find the game that contains this guest
      const game = await gameRepo.getGame(payload.gameId);

      if (!game || !game.playerIds.includes(guestId)) {
        const response: ClaimGuestSessionResponse = {
          success: true,
          gamesLinked: 0,
        };
        res.status(200).json(response);
        return;
      }

      // Swap guestId for newUserId in this game
      const guestDisplayName = game.playerDisplayNames[guestId] ?? guestId;

      game.playerIds = game.playerIds.map((id) =>
        id === guestId ? newUserId : id,
      );
      delete game.playerDisplayNames[guestId];
      game.playerDisplayNames[newUserId] = guestDisplayName;

      await gameRepo.saveGame(game);

      const response: ClaimGuestSessionResponse = {
        success: true,
        gamesLinked: 1,
      };
      res.status(200).json(response);
    },
  );

  return router;
}
