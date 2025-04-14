import { type Request, type Response } from '@/util/types'
import { Handler } from '@/api/handler'
import { CreateGameRequest, CreateGameResponse } from '@shared/model'
import { PostgresDB } from '@/database/postgres';
import { BadRequestError } from '@/util/errors';

export class CreateGameHandler extends Handler {
    public static INSTANCE: CreateGameHandler = new CreateGameHandler();
    private constructor() {
        super();
    }

    public override async post(request: Request<CreateGameRequest>, response: Response<CreateGameResponse>) {
        this.validateRequest(request);
        const game = await PostgresDB.INSTANCE.createGame(request.body.gameType, request.accountId!, request.body.numPlayers);
        const createGameResponse: CreateGameResponse = {
            gameId: game.gameId,
            gameType: request.body.gameType,
        }
        response.status(200).json(createGameResponse);
    }

    private validateRequest(request: Request<CreateGameRequest>) {
        [request.accountId, request.body.gameType, request.body.numPlayers].forEach((value) => {
            if (!value) {
                console.error(`Invalid request received. AccountId: ${request.accountId}, Request: ${request.body}`);
                throw new BadRequestError();
            }
        });
    }
}