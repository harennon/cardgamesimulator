import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import { CreateGameRequest, CreateGameResponse } from "@shared/model";
import { gameRepo } from "@/database";
import { BadRequestError } from "@/util/errors";
import { generateJoinCode } from "@/service/joinCodeService";
import { Game } from "@/database/entities/Game";
import type { GameType } from "@shared/engine-types";

const VALID_TIMER_VALUES: ReadonlySet<number> = new Set([30, 60, 90]);

// deckRoundsTarget is a continuous range, validated here as the authoritative API
// boundary (the Tonk engine re-clamps as defense-in-depth). Mirrors engine
// constants MIN/MAX_DECK_ROUNDS_TARGET (engine/tonk/constants.ts).
const MIN_DECK_ROUNDS_TARGET = 5;
const MAX_DECK_ROUNDS_TARGET = 12;

export class CreateGameHandler extends Handler {
  public static INSTANCE: CreateGameHandler = new CreateGameHandler();

  public override async post(
    request: Request<CreateGameRequest>,
    response: Response<CreateGameResponse>,
  ) {
    this.validateRequest(request);
    const turnTimerSeconds = request.body.turnTimerSeconds;
    if (turnTimerSeconds == null || !VALID_TIMER_VALUES.has(turnTimerSeconds)) {
      throw new BadRequestError();
    }
    const deckRoundsTarget = request.body.deckRoundsTarget;
    if (
      deckRoundsTarget != null &&
      (!Number.isInteger(deckRoundsTarget) ||
        deckRoundsTarget < MIN_DECK_ROUNDS_TARGET ||
        deckRoundsTarget > MAX_DECK_ROUNDS_TARGET)
    ) {
      throw new BadRequestError();
    }
    const gameId = crypto.randomUUID();
    const game = await this.createGameWithCode(
      gameId,
      request.body.gameType,
      request.userId!,
      request.body.maxPlayers,
      request.displayName ?? request.userId!,
      turnTimerSeconds,
      deckRoundsTarget ?? null,
    );
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
    deckRoundsTarget: number | null,
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
          deckRoundsTarget,
          generateJoinCode(),
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
          console.error(
            `Invalid request received. UserId: ${request.userId}, Request: ${request.body}`,
          );
          throw new BadRequestError();
        }
      },
    );
  }
}
