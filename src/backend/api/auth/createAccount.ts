import { type Request, type Response } from '@/util/types'
import { Handler } from '@/api/handler'
import { CreateAccountRequest, CreateAccountResponse } from '@shared/model'
import { AuthNService } from '@/service/authNService';

export class CreateAccountHandler extends Handler {
    public static INSTANCE: CreateAccountHandler = new CreateAccountHandler();
    private constructor() {
        super();
    }

    public override async post(request: Request<CreateAccountRequest>, response: Response<CreateAccountResponse>) {
        const jwt = await AuthNService.INSTANCE.createAccount(request.body.authRequestId, request.body.payload);

        const createAccountResponse: CreateAccountResponse = {
            authRequestId: request.body.authRequestId,
            jwt: jwt,
        }
        response.status(200).json(createAccountResponse);
    }
}