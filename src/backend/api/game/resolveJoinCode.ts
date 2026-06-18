import express, { type Router } from "express";
import type { Request, Response } from "@/util/types";
import { NotFoundError } from "@/util/errors";
import type { GameRepository } from "@/database/database";
import type { ResolveJoinCodeResponse } from "@shared/model";

export function createResolveJoinCodeRouter(gameRepo: GameRepository): Router {
  const router = express.Router();

  router.get(
    "/:code",
    async (req: Request, res: Response<ResolveJoinCodeResponse>) => {
      const code = (req.params as Record<string, string>).code;
      if (!code || typeof code !== "string") {
        throw new NotFoundError();
      }
      const game = await gameRepo.getGameByJoinCode(code.toUpperCase());
      if (!game) {
        throw new NotFoundError();
      }
      res.status(200).json({ gameId: game.gameId });
    },
  );

  return router;
}
