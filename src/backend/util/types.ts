import {
  NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from "express";

// Express's generic params use `any` internally; eslint-disable is required here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Request<ReqBody = unknown> = ExpressRequest<any, any, ReqBody> & {
  userId?: string; // Supabase user UUID (from JWT sub claim)
  displayName?: string; // from JWT user_metadata.display_name, falls back to email
  isGuest?: boolean; // true for guest sessions
};

export type Response<ResBody = unknown> = ExpressResponse<ResBody>;

export type Next = NextFunction;
