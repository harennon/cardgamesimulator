import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import { CreateGameRequest, CreateGameResponse } from "@shared/model";
import { gameRepo } from "@/database";
import { BadRequestError } from "@/util/errors";

const VALID_TIMER_VALUES: ReadonlySet<number | null> = new Set([
  null,
  30,
  60,
  90,
]);

export class CreateGameHandler extends Handler {
  public static INSTANCE: CreateGameHandler = new CreateGameHandler();
  private constructor() {
    super();
  }

  public override async post(
    request: Request<CreateGameRequest>,
    response: Response<CreateGameResponse>,
  ) {
    this.validateRequest(request);
    const turnTimerSeconds = request.body.turnTimerSeconds ?? null;
    if (!VALID_TIMER_VALUES.has(turnTimerSeconds)) {
      throw new BadRequestError();
    }
    const gameId = crypto.randomUUID();
    const game = await gameRepo.createGame(
      gameId,
      request.body.gameType,
      request.userId!,
      request.body.maxPlayers,
      request.displayName ?? request.userId!,
      turnTimerSeconds,
    );
    const createGameResponse: CreateGameResponse = {
      gameId: game.gameId,
      gameType: request.body.gameType,
    };
    response.status(200).json(createGameResponse);
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
