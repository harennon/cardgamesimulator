import { type Request, type Response } from '@/util/types'
import { Handler } from '@/api/handler'
import { GameType, JoinGameRequest, JoinGameResponse } from '@shared/model'
import { gameRepo } from '@/database';
import { BadRequestError, NotFoundError } from '@/util/errors';

export class JoinGameHandler extends Handler {
    public static INSTANCE: JoinGameHandler = new JoinGameHandler();
    private constructor() {
        super();
    }

    public override async post(request: Request<JoinGameRequest>, response: Response<JoinGameResponse>) {
        this.validateRequest(request);

        // check if game exists
        const game = await gameRepo.getGame(request.body.gameId);
        if (game === null) {
            throw new NotFoundError();
        }

        if (game.playerIds.push(request.userId!) > game.maxPlayers) {
            console.error("Cannot join game as max players has been met");
            throw new BadRequestError();
        };

        await gameRepo.saveGame(game);

        const joinGameResponse: JoinGameResponse = {
            gameId: game.gameId,
            gameType: game.gameType as GameType,
        }
        response.status(200).json(joinGameResponse);
    }

    private validateRequest(request: Request<JoinGameRequest>) {
        [request.userId, request.body.gameId].forEach((value) => {
            if (!value) {
                console.error(`Invalid request received. UserId: ${request.userId}, Request: ${request.body}`);
                throw new BadRequestError();
            }
        });
    }
}
