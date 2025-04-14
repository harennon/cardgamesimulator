import { Handler } from '@/api/handler'
import { GetAuthTokenRequest, GetAuthTokenResponse } from '@shared/model'
import { type Request, type Response } from '@/util/types'
import { AuthNService } from '@/service/authNService';

export class GetAuthTokenHandler extends Handler {
    public static INSTANCE: GetAuthTokenHandler = new GetAuthTokenHandler();
    private constructor() {
        super();
    }

    public override async post(request: Request<GetAuthTokenRequest>, response: Response<GetAuthTokenResponse>) {
        const jwt = await AuthNService.INSTANCE.signInAccount(request.body.authRequestId, request.body.payload);

        const authTokenResponse: GetAuthTokenResponse = {
            jwt: jwt,
            authRequestId: request.body.authRequestId,
        }
        response.status(200).json(authTokenResponse);
    }
}