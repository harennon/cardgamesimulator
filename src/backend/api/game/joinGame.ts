import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import { GameType, JoinGameRequest, JoinGameResponse } from "@shared/model";
import { gameRepo } from "@/database";
import {
  AlreadyExistsError,
  BadRequestError,
  NotFoundError,
} from "@/util/errors";

export class JoinGameHandler extends Handler {
  public static INSTANCE: JoinGameHandler = new JoinGameHandler();
  private constructor() {
    super();
  }

  public override async post(
    request: Request<JoinGameRequest>,
    response: Response<JoinGameResponse>,
  ) {
    this.validateRequest(request);

    const userId = request.userId!;
    const gameId = request.body.gameId;

    const { game, mutated } = await this.loadAndJoin(gameId, userId);

    if (mutated) {
      try {
        await gameRepo.saveGame(game);
      } catch (e: unknown) {
        if (
          e instanceof Error &&
          e.name === "OptimisticLockVersionMismatchError"
        ) {
          const retry = await this.loadAndJoin(gameId, userId);
          try {
            await gameRepo.saveGame(retry.game);
          } catch (retryErr: unknown) {
            if (
              retryErr instanceof Error &&
              retryErr.name === "OptimisticLockVersionMismatchError"
            ) {
              throw new AlreadyExistsError();
            }
            throw retryErr;
          }
        } else {
          throw e;
        }
      }
    }

    const joinGameResponse: JoinGameResponse = {
      gameId: game.gameId,
      gameType: game.gameType as GameType,
    };
    response.status(200).json(joinGameResponse);
  }

  private async loadAndJoin(gameId: string, userId: string) {
    const game = await gameRepo.getGame(gameId);
    if (game === null) {
      throw new NotFoundError();
    }

    if (game.playerIds.includes(userId)) {
      return { game, mutated: false };
    }

    if (game.playerIds.length >= game.maxPlayers) {
      throw new BadRequestError();
    }

    game.playerIds.push(userId);
    return { game, mutated: true };
  }

  private validateRequest(request: Request<JoinGameRequest>) {
    [request.userId, request.body.gameId].forEach((value) => {
      if (!value) {
        console.error(
          `Invalid request received. UserId: ${request.userId}, Request: ${request.body}`,
        );
        throw new BadRequestError();
      }
    });
  }
}
