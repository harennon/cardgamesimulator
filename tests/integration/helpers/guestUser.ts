import request from "supertest";
import type { Application } from "express";

export interface TestGuest {
  guestId: string;
  displayName: string;
  token: string;
}

/**
 * Creates a guest session via POST /guest/session and returns the guest token.
 */
export async function createTestGuest(
  app: Application,
  gameId: string,
  displayName: string,
): Promise<TestGuest> {
  const res = await request(app)
    .post("/guest/session")
    .send({ gameId, displayName });

  if (res.status !== 200) {
    throw new Error(
      `Failed to create guest session: status ${res.status}, body: ${JSON.stringify(res.body)}`,
    );
  }

  return {
    guestId: res.body.guestId as string,
    displayName: res.body.displayName as string,
    token: res.body.token as string,
  };
}
