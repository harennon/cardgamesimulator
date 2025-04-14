import { type Request, type Response } from '@/util/types'
import { Handler } from '@/api/handler'
import { GetGameStateRequest, GetGameStateResponse } from '@shared/model'
import { PostgresDB } from '@/database/postgres';
import { AccessDeniedError, BadRequestError, NotFoundError } from '@/util/errors';
import { serializeGameForPlayer } from '@/util/serializer';

export class GetGameStateHandler extends Handler {
    public static INSTANCE: GetGameStateHandler = new GetGameStateHandler();
    private constructor() {
        super();
    }

    public override async get(request: Request<GetGameStateRequest>, response: Response<GetGameStateResponse>) {
        this.validateRequest(request);

        // check if game exists
        const game = await PostgresDB.INSTANCE.getGame(request.query.gameId as string);
        if (game === null) {
            throw new NotFoundError();
        }

        const getGameStateResponse: GetGameStateResponse = {
            gameId: game.gameId,
            gameState: serializeGameForPlayer(game, request.accountId!),
        };
        response.status(200).json(getGameStateResponse);
    }

    private validateRequest(request: Request<GetGameStateRequest>) {
        [request.query.accountId, request.query.gameId].forEach((value) => {
            if (!value) {
                console.error(`Invalid request received. AccountId: ${request.accountId}, Request: ${request.body}`);
                throw new BadRequestError();
            }
        });

        if (request.query.accountId !== request.accountId) {
            console.error(`GetGameState called for another accountId`);
            throw new AccessDeniedError();
        }
    }
}