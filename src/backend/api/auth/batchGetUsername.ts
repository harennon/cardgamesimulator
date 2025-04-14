import { type Request, type Response } from '@/util/types';
import { Handler } from '@/api/handler';
import { Account, AccountFailure, BatchGetUsernameRequest, BatchGetUsernameResponse } from '@shared/model';
import { PostgresDB } from '@/database/postgres';
import { BadRequestError } from '@/util/errors';

export class BatchGetUsernameHandler extends Handler {
    public static INSTANCE: BatchGetUsernameHandler = new BatchGetUsernameHandler();
    private constructor() {
        super();
    }

    public override async post(request: Request<BatchGetUsernameRequest>, response: Response<BatchGetUsernameResponse>) {
        if (!request.body.accountIds || !Array.isArray(request.body.accountIds)) {
            throw new BadRequestError();
        }

        const getAccountByIdResponse = await PostgresDB.INSTANCE.getAccountsByIds(request.body.accountIds);
        console.log(getAccountByIdResponse);
        const failures: AccountFailure[] = [];
        const accounts: Account[] = [];
        for (const accountId of request.body.accountIds) {
            const account = getAccountByIdResponse.find((account) => {
                console.log(`${accountId} === ${account.accountId}`);
                return account.accountId === accountId;
            });
            if (account) {
                accounts.push({ accountId: account.accountId, username: account.username } as Account);
            } else {
                failures.push({ accountId: accountId, failureReason: 'NOT_FOUND', failureCode: 404 } as AccountFailure)
            }
        }

        const resBody: BatchGetUsernameResponse = {
            accounts: accounts,
            failures: failures,
        };

        response.status(200).json(resBody)
    }
}