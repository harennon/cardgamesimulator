import { Handler } from '@/api/handler'
import { ServeAssetHandler } from '@/api/serveAsset';
import { type Request, type Response } from '@/util/types';

export class ServeAppHandler extends Handler {
    public static INSTANCE: ServeAppHandler = new ServeAppHandler();
    private constructor() {
        super()
    }

    public override async get(request: Request, response: Response) {
        request.url = '/assets/index.html'
        ServeAssetHandler.INSTANCE.get(request, response);
    }
}