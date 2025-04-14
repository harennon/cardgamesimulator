import { Handler } from '@/api/handler'
import { BadRequestError } from '@/util/errors';
import { type Request, type Response } from '@/util/types';

export class ServeAssetHandler extends Handler {
    public static INSTANCE: ServeAssetHandler = new ServeAssetHandler();
    private constructor() {
        super()
    }

    public override async get(request: Request, _response: Response) {
        if (request.url === undefined) {
            throw new BadRequestError();
        }
    }
}