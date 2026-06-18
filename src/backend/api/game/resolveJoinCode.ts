import express, { type Router } from "express";
import type { Request, Response } from "@/util/types";
import { NotFoundError } from "@/util/errors";
import type { JoinCodeService } from "@/service/joinCodeService";
import type { ResolveJoinCodeResponse } from "@shared/model";

// GET /api/games/join/:code
// No auth required — guests need to resolve codes before they have a session.
// Response: 200 { gameId: string } or 404 { error: "CODE_NOT_FOUND" }
export function createResolveJoinCodeRouter(
  joinCodeService: JoinCodeService,
): Router {
  const router = express.Router();

  router.get(
    "/:code",
    async (req: Request, res: Response<ResolveJoinCodeResponse>) => {
      const code = (req.params as Record<string, string>).code;
      if (!code || typeof code !== "string") {
        throw new NotFoundError();
      }
      const gameId = await joinCodeService.resolveCode(code.toUpperCase());
      if (!gameId) {
        throw new NotFoundError();
      }
      res.status(200).json({ gameId });
    },
  );

  return router;
}
