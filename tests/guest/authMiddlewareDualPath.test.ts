import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { createGuestToken } from "../../src/backend/guest/guestToken.js";
import { GuestSessionStore } from "../../src/backend/guest/guestSessionStore.js";

const TEST_JWT_SECRET = "test-jwt-secret-for-dual-path";

process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;

const { createAuthMiddleware, registeredOnlyMiddleware } =
  await import("../../src/backend/middleware/authMiddleware.js");
import type { Request, Response, Next } from "../../src/backend/util/types.js";

const GUEST_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const GAME_ID = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

function makeStore(
  guestId = GUEST_ID,
  displayName = "Alice",
  gameId = GAME_ID,
): GuestSessionStore {
  const store = new GuestSessionStore();
  store.create(displayName, gameId, 3_600_000, guestId);
  return store;
}

function makeRequest(overrides: Partial<Request> = {}): Request {
  return { headers: {}, ...overrides } as unknown as Request;
}

function makeNext(): { fn: Next; called: boolean } {
  const state = { called: false };
  const fn: Next = () => {
    state.called = true;
  };
  return { fn, called: state.called };
}

function validJwt(overrides: object = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: "registered-user-uuid",
      email: "user@example.com",
      role: "authenticated",
      aud: "authenticated",
      iat: now,
      exp: now + 3600,
      user_metadata: { display_name: "Reg User" },
      ...overrides,
    },
    TEST_JWT_SECRET,
    { algorithm: "HS256" },
  );
}

function validGuestToken(guestId = GUEST_ID, gameId = GAME_ID): string {
  return createGuestToken(
    guestId,
    gameId,
    Date.now() + 3_600_000,
    TEST_JWT_SECRET,
  );
}

function expectUnauthorized(fn: () => void): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  expect((thrown as { status?: number }).status).toBe(401);
}

describe("createAuthMiddleware — Supabase JWT path (regression)", () => {
  it("accepts a valid Supabase JWT and sets req.userId / req.isGuest=false", () => {
    const store = new GuestSessionStore();
    const middleware = createAuthMiddleware(store);
    const token = validJwt({ sub: "supabase-user-uuid" });
    const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
    const { fn: next } = makeNext();
    middleware(req, {} as Response, next);
    expect(req.userId).toBe("supabase-user-uuid");
    expect(req.isGuest).toBe(false);
  });

  it("throws 401 for a missing token (regression)", () => {
    const store = new GuestSessionStore();
    const middleware = createAuthMiddleware(store);
    const req = makeRequest({ headers: {} });
    const { fn: next } = makeNext();
    expectUnauthorized(() => middleware(req, {} as Response, next));
  });

  it("throws 401 for a wrong-secret JWT (regression)", () => {
    const store = new GuestSessionStore();
    const middleware = createAuthMiddleware(store);
    const token = jwt.sign(
      { sub: "u1", email: "a@b.com", role: "authenticated", user_metadata: {} },
      "wrong-secret",
      { algorithm: "HS256" },
    );
    const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
    const { fn: next } = makeNext();
    expectUnauthorized(() => middleware(req, {} as Response, next));
  });
});

describe("createAuthMiddleware — guest token path", () => {
  it("accepts a valid guest token and sets req.userId, req.displayName, req.isGuest=true", () => {
    const store = makeStore(GUEST_ID, "Alice");
    const middleware = createAuthMiddleware(store);
    const token = validGuestToken();
    const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
    const { fn: next } = makeNext();
    middleware(req, {} as Response, next);
    expect(req.userId).toBe(GUEST_ID);
    expect(req.displayName).toBe("Alice");
    expect(req.isGuest).toBe(true);
  });

  it("throws 401 for an invalid guest token (HMAC tampered)", () => {
    const store = makeStore();
    const middleware = createAuthMiddleware(store);
    const token =
      "guest:" + Buffer.from("tampered.payload.nosig").toString("base64url");
    const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
    const { fn: next } = makeNext();
    expectUnauthorized(() => middleware(req, {} as Response, next));
  });

  it("throws 401 for a valid guest token when session is evicted from store", () => {
    const store = new GuestSessionStore(); // empty store — session was never added
    const middleware = createAuthMiddleware(store);
    const token = validGuestToken();
    const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
    const { fn: next } = makeNext();
    expectUnauthorized(() => middleware(req, {} as Response, next));
  });

  it("throws 401 for an expired guest token", () => {
    const store = makeStore();
    const middleware = createAuthMiddleware(store);
    const expiredToken = createGuestToken(
      GUEST_ID,
      GAME_ID,
      Date.now() - 1000,
      TEST_JWT_SECRET,
    );
    const req = makeRequest({
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    const { fn: next } = makeNext();
    expectUnauthorized(() => middleware(req, {} as Response, next));
  });
});

describe("registeredOnlyMiddleware", () => {
  it("calls next() when req.isGuest is false", () => {
    const req = makeRequest({ isGuest: false } as Partial<Request>);
    let called = false;
    const next: Next = () => {
      called = true;
    };
    registeredOnlyMiddleware(req, {} as Response, next);
    expect(called).toBe(true);
  });

  it("calls next() when req.isGuest is undefined (legacy routes without isGuest set)", () => {
    const req = makeRequest();
    let called = false;
    const next: Next = () => {
      called = true;
    };
    registeredOnlyMiddleware(req, {} as Response, next);
    expect(called).toBe(true);
  });

  it("throws 403 when req.isGuest is true", () => {
    const req = makeRequest({ isGuest: true } as Partial<Request>);
    let thrown: unknown;
    try {
      registeredOnlyMiddleware(req, {} as Response, () => undefined);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { status?: number }).status).toBe(403);
  });
});
