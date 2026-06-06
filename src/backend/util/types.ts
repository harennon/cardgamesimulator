import { NextFunction, type Request as ExpressRequest, type Response as ExpressResponse } from 'express';

export type Request<ReqBody = any> = ExpressRequest<any, any, ReqBody> & {
  userId?: string;       // Supabase user UUID (from JWT sub claim)
  displayName?: string;  // from JWT user_metadata.display_name, falls back to email
};

export type Response<ReqBody = any> = ExpressResponse<ReqBody>;

export type Next = NextFunction;
