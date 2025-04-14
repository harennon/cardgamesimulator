import { AuthNJWTPayload, AuthNService } from "@/service/authNService";
import { UnauthorizedError } from "@/util/errors";
import { Next, Request, Response } from "@/util/types";

export const authNHandler = function (req: Request, _res: Response, next: Next) {
    const authHeader = req.headers.authorization;
    let token: string | undefined = authHeader && authHeader.split(' ')[1];
    if (req.baseUrl === '/event') {
        // we need to extract the token from cookie for /event due to EventSource limitations
        token = req.cookies['jwt'];
    }

    if (token == null) {
        throw new UnauthorizedError();
    }

    const payload: AuthNJWTPayload = AuthNService.INSTANCE.verifyAuthNToken(token);
    req.accountId = payload.sub;
    
    next();
};
