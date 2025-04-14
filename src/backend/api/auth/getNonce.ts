import * as crypto from 'node:crypto';

import { type Request, type Response } from '@/util/types';
import { Handler } from '@/api/handler';
import { GetNonceRequest, GetNonceResponse } from '@shared/model';
import { PostgresDB } from '@/database/postgres';

export class GenerateNonceHandler extends Handler {
    public static INSTANCE: GenerateNonceHandler = new GenerateNonceHandler();
    private constructor() {
        super();
    }

    public override async get(request: Request<GetNonceRequest>, response: Response<GetNonceResponse>) {
        // generate a requestId if one was not passed in
        let requestId: string;
        if (!!request.query.authRequestId && typeof request.query.authRequestId === 'string') {
            requestId = request.query.authRequestId;
        } else {
            requestId = crypto.randomUUID();
        }
        const nonce = crypto.randomBytes(16).toString('base64')

        // correlate clientAuthId with nonce for auth requests later
        await PostgresDB.INSTANCE.saveNonce(requestId, nonce);
        
        const getNonceResponse: GetNonceResponse = { authRequestId: requestId, nonce: nonce };
        response.status(200).json(getNonceResponse);
    }
}