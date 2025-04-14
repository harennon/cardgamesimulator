import { NextFunction, type Request as ExpressRequest, type Response as ExpressResponse } from 'express';

export type Request<ReqBody = any> = ExpressRequest<any, any, ReqBody> & {
    accountId?: string
};

export type Response<ReqBody = any> = ExpressResponse<ReqBody>;

export type Next = NextFunction;
