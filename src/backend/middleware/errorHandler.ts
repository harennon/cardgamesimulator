import { instanceOfErrorWithStatus, InternalServerError } from "@/util/errors";
import { Next, Request, Response } from "@/util/types";

export const errorHandler = function (err: Error, _req: Request, res: Response, next: Next) { 
    console.error(err.stack);
    if (res.headersSent) {
        return next(err)
    }

    if (instanceOfErrorWithStatus(err)) {
        res.status(err.status).send(err.message);
    } else {
        res.status(500).send(InternalServerError.message);
    }
    // other errors are handled by default handler
}