import { type Request, type Response } from '@/util/types'
import { Handler } from '@/api/handler'
import { GetGameStateRequest, GetGameStateResponse } from '@shared/model'
import { gameRepo } from '@/database';
import { BadRequestError, NotFoundError } from '@/util/errors';
import { serializeGameForPlayer } from '@/util/serializer';

export class GetGameStateHandler extends Handler {
    public static INSTANCE: GetGameStateHandler = new GetGameStateHandler();
    private constructor() {
        super();
    }

    public override async get(request: Request<GetGameStateRequest>, response: Response<GetGameStateResponse>) {
        this.validateRequest(request);

        // check if game exists
        const game = await gameRepo.getGame(request.query.gameId as string);
        if (game === null) {
            throw new NotFoundError();
        }

        const getGameStateResponse: GetGameStateResponse = {
            gameId: game.gameId,
            gameState: serializeGameForPlayer(game, request.userId!),
        };
        response.status(200).json(getGameStateResponse);
    }

    private validateRequest(request: Request<GetGameStateRequest>) {
        if (!request.query.gameId) {
            console.error(`Invalid request received. UserId: ${request.userId}, Request: ${request.body}`);
            throw new BadRequestError();
        }
    }
}
