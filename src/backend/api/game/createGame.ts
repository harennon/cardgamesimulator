import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import {
  CreateGameRequest,
  CreateGameResponse,
  GameConfig,
} from "@shared/model";
import { gameRepo } from "@/database";
import { BadRequestError } from "@/util/errors";
import { generateJoinCode } from "@/service/joinCodeService";
import { Game } from "@/database/entities/Game";
import type { GameType } from "@shared/engine-types";
import type { GameService } from "@/service/gameService";
import { logger } from "@/util/logger";

const VALID_TIMER_VALUES: ReadonlySet<number> = new Set([30, 60, 90]);

const MIN_DECK_ROUNDS = 5;
const MAX_DECK_ROUNDS = 12;
const DEFAULT_DECK_ROUNDS = 8;

/**
 * Validate the creator-supplied deckRoundsTarget. Returns the value when present
 * and a valid integer in [5,12]; returns the default 8 when omitted. Throws
 * BadRequestError when present-but-invalid (non-integer, out of range). Unlike
 * turnTimerSeconds, an omitted value is a valid "use the default" request.
 */
function resolveDeckRoundsTargetOrThrow(raw: number | undefined): number {
  if (raw == null) return DEFAULT_DECK_ROUNDS;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < MIN_DECK_ROUNDS ||
    raw > MAX_DECK_ROUNDS
  ) {
    throw new BadRequestError();
  }
  return raw;
}

/**
 * Validate and resolve numAiSeats from the request body.
 * Returns 0 when absent/0 (human-only game; no addAiSeats call needed).
 * Throws BadRequestError for:
 *   - non-integer or negative value
 *   - value exceeding maxPlayers - 1 (at least one human seat required)
 *   - value >= 1 from a guest (registered-host-only capability)
 */
export function validateNumAiSeatsOrThrow(
  raw: unknown,
  maxPlayers: number,
  isRegisteredHost: boolean,
): number {
  if (raw == null || raw === 0) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new BadRequestError();
  }
  if (raw > maxPlayers - 1) {
    throw new BadRequestError();
  }
  if (!isRegisteredHost) {
    throw new BadRequestError();
  }
  return raw;
}

export class CreateGameHandler extends Handler {
  public static INSTANCE: CreateGameHandler = new CreateGameHandler(null);

  private constructor(private readonly gameService: GameService | null) {
    super();
  }

  /**
   * Create a new instance wired to a GameService (used in server.ts).
   * The INSTANCE singleton remains null-wired for legacy imports; the
   * server.ts wired instance is used at runtime.
   */
  public static create(gameService: GameService): CreateGameHandler {
    return new CreateGameHandler(gameService);
  }

  public override async post(
    request: Request<CreateGameRequest>,
    response: Response<CreateGameResponse>,
  ) {
    this.validateRequest(request);
    const turnTimerSeconds = request.body.turnTimerSeconds;
    if (turnTimerSeconds == null || !VALID_TIMER_VALUES.has(turnTimerSeconds)) {
      throw new BadRequestError();
    }
    // Validate deckRoundsTarget regardless of game type (an out-of-range value
    // is a 400 either way); only persist it for Tonk — Big2's config stays {}.
    const deckRoundsTarget = resolveDeckRoundsTargetOrThrow(
      request.body.deckRoundsTarget,
    );
    const gameConfig: GameConfig =
      request.body.gameType === "tonk" ? { deckRoundsTarget } : {};

    const isRegisteredHost = request.isGuest !== true;
    const numAiSeats = validateNumAiSeatsOrThrow(
      request.body.numAiSeats,
      request.body.maxPlayers,
      isRegisteredHost,
    );

    const gameId = crypto.randomUUID();
    const game = await this.createGameWithCode(
      gameId,
      request.body.gameType,
      request.userId!,
      request.body.maxPlayers,
      request.displayName ?? request.userId!,
      turnTimerSeconds,
      gameConfig,
    );

    if (numAiSeats >= 1) {
      if (this.gameService == null) {
        throw new Error("INTERNAL_ERROR: gameService not wired");
      }
      await this.gameService.addAiSeats(game.gameId, numAiSeats);
    }

    const createGameResponse: CreateGameResponse = {
      gameId: game.gameId,
      gameType: request.body.gameType,
      joinCode: game.joinCode ?? "",
    };
    response.status(200).json(createGameResponse);
  }

  private async createGameWithCode(
    gameId: string,
    gameType: GameType,
    creatorId: string,
    maxPlayers: number,
    creatorDisplayName: string,
    turnTimerSeconds: number | null,
    gameConfig: GameConfig,
  ): Promise<Game> {
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await gameRepo.createGame(
          gameId,
          gameType,
          creatorId,
          maxPlayers,
          creatorDisplayName,
          turnTimerSeconds,
          generateJoinCode(),
          gameConfig,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("duplicate") || msg.includes("unique")) continue;
        throw err;
      }
    }
    throw new Error("Failed to generate unique join code after max retries");
  }

  private validateRequest(request: Request<CreateGameRequest>) {
    [request.userId, request.body.gameType, request.body.maxPlayers].forEach(
      (value) => {
        if (!value) {
          logger.warn(
            { userId: request.userId },
            "Invalid createGame request received",
          );
          throw new BadRequestError();
        }
      },
    );
  }
}
