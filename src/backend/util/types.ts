import {
  NextFunction,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from "express";
import type pino from "pino";

// Express's generic params use `any` internally; eslint-disable is required here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Request<ReqBody = unknown> = ExpressRequest<any, any, ReqBody> & {
  userId?: string; // Supabase user UUID (from JWT sub claim)
  displayName?: string; // from JWT user_metadata.display_name, falls back to email
  isGuest?: boolean; // true for guest sessions
  /** Child logger carrying requestId + correlationId, minted by the correlation middleware.
   *  Optional because Express does not know about augmentations; always present at runtime
   *  for routes that go through the correlation middleware. */
  log?: pino.Logger;
};

export type Response<ResBody = unknown> = ExpressResponse<ResBody>;

export type Next = NextFunction;
