import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import { CreateGameRequest, CreateGameResponse } from "@shared/model";
import { gameRepo, joinCodeRepo } from "@/database";
import { BadRequestError } from "@/util/errors";
import { JoinCodeService } from "@/service/joinCodeService";

const VALID_TIMER_VALUES: ReadonlySet<number> = new Set([30, 60, 90]);

export class CreateGameHandler extends Handler {
  public static INSTANCE: CreateGameHandler = new CreateGameHandler(
    new JoinCodeService(joinCodeRepo),
  );
  private constructor(private readonly joinCodeService: JoinCodeService) {
    super();
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
    const gameId = crypto.randomUUID();
    const game = await gameRepo.createGame(
      gameId,
      request.body.gameType,
      request.userId!,
      request.body.maxPlayers,
      request.displayName ?? request.userId!,
      turnTimerSeconds,
    );
    // Generate code after game row exists to satisfy the FK constraint on join_codes.
    // If code generation fails, the game is still accessible via direct link.
    let joinCode: string;
    try {
      joinCode = await this.joinCodeService.generateCode(gameId);
    } catch (err) {
      console.error(`Failed to generate join code for game ${gameId}:`, err);
      joinCode = "";
    }
    const createGameResponse: CreateGameResponse = {
      gameId: game.gameId,
      gameType: request.body.gameType,
      joinCode,
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
