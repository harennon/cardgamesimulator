import express, { type Router } from "express";
import type { Request, Response } from "@/util/types";
import type { GuestSessionStore } from "@/guest/guestSessionStore";
import type { GameRepository } from "@/database/database";
import { createGuestToken } from "@/guest/guestToken";
import { BadRequestError, NotFoundError } from "@/util/errors";
import type {
  CreateGuestSessionRequest,
  CreateGuestSessionResponse,
} from "@shared/guest-types";

const GUEST_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_DISPLAY_NAME_LENGTH = 20;

function deduplicateDisplayName(
  requested: string,
  existingNames: string[],
): string {
  if (!existingNames.includes(requested)) {
    return requested;
  }
  let candidate = requested;
  let suffix = 2;
  while (existingNames.includes(candidate)) {
    candidate = `${requested}${suffix}`;
    suffix++;
  }
  return candidate;
}

export function createSessionRouter(
  guestSessionStore: GuestSessionStore,
  gameRepo: GameRepository,
): Router {
  const router = express.Router();

  router.post(
    "/",
    async (
      req: Request<CreateGuestSessionRequest>,
      res: Response<CreateGuestSessionResponse>,
    ) => {
      const { displayName, gameId, existingGuestId } = req.body;

      if (!displayName || typeof displayName !== "string") {
        throw new BadRequestError();
      }
      const trimmedName = displayName.trim();
      if (
        trimmedName.length === 0 ||
        trimmedName.length > MAX_DISPLAY_NAME_LENGTH
      ) {
        throw new BadRequestError();
      }
      if (!gameId || typeof gameId !== "string") {
        throw new BadRequestError();
      }

      const game = await gameRepo.getGame(gameId);
      if (!game) {
        throw new NotFoundError();
      }

      // Validate existingGuestId: only allow re-creation if the ID is already in the game's playerIds.
      // This prevents session hijacking — an attacker cannot claim an arbitrary UUID.
      const UUID_REGEX =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const validatedExistingId =
        existingGuestId &&
        UUID_REGEX.test(existingGuestId) &&
        game.playerIds.includes(existingGuestId)
          ? existingGuestId
          : undefined;

      const existingNames = Object.values(game.playerDisplayNames);
      const finalDisplayName = deduplicateDisplayName(
        trimmedName,
        existingNames,
      );

      const jwtSecret = process.env.SUPABASE_JWT_SECRET!;

      const session = guestSessionStore.create(
        finalDisplayName,
        gameId,
        GUEST_SESSION_TTL_MS,
        validatedExistingId,
      );

      const token = createGuestToken(
        session.guestId,
        gameId,
        session.expiresAt,
        jwtSecret,
      );

      const response: CreateGuestSessionResponse = {
        guestId: session.guestId,
        displayName: session.displayName,
        token,
        gameId,
      };

      res.status(200).json(response);
    },
  );

  return router;
}
