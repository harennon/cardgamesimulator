import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { createGuestToken } from "../../src/backend/guest/guestToken.js";
import { GuestSessionStore } from "../../src/backend/guest/guestSessionStore.js";
import type { TypedSocket } from "../../src/backend/websocket/socketServer.js";

const TEST_JWT_SECRET = "test-jwt-secret-for-socket-dual-path";

process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;

const { createSocketAuthMiddleware } =
  await import("../../src/backend/websocket/socketAuth.js");

const GUEST_ID = "c3d4e5f6-a7b8-9012-cdef-012345678902";
const GAME_ID = "d4e5f6a7-b8c9-0123-defa-123456789013";

function makeSocket(token?: unknown): TypedSocket {
  return {
    handshake: { auth: token !== undefined ? { token } : {} },
    data: {} as Record<string, unknown>,
  } as unknown as TypedSocket;
}

function captureNext(): { fn: (err?: Error) => void; errors: Error[] } {
  const errors: Error[] = [];
  const fn = (err?: Error) => {
    if (err) errors.push(err);
  };
  return { fn, errors };
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

function makeStore(
  guestId = GUEST_ID,
  displayName = "GuestPlayer",
  gameId = GAME_ID,
): GuestSessionStore {
  const store = new GuestSessionStore();
  store.create(displayName, gameId, 3_600_000, guestId);
  return store;
}

describe("createSocketAuthMiddleware — Supabase JWT path (regression)", () => {
  it("sets socket.data.userId and isGuest=false for a valid JWT", () => {
    const store = new GuestSessionStore();
    const middleware = createSocketAuthMiddleware(store);
    const token = validJwt({ sub: "socket-user-uuid" });
    const socket = makeSocket(token);
    const { fn: next, errors } = captureNext();
    middleware(socket, next);
    expect(errors).toHaveLength(0);
    expect(socket.data.userId).toBe("socket-user-uuid");
    expect(socket.data.isGuest).toBe(false);
  });

  it("calls next with UNAUTHORIZED for missing token (regression)", () => {
    const store = new GuestSessionStore();
    const middleware = createSocketAuthMiddleware(store);
    const socket = makeSocket();
    const { fn: next, errors } = captureNext();
    middleware(socket, next);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/UNAUTHORIZED/);
  });
});

describe("createSocketAuthMiddleware — guest token path", () => {
  it("sets socket.data.userId, displayName, and isGuest=true for a valid guest token", () => {
    const store = makeStore(GUEST_ID, "GuestPlayer");
    const middleware = createSocketAuthMiddleware(store);
    const token = createGuestToken(
      GUEST_ID,
      GAME_ID,
      Date.now() + 3_600_000,
      TEST_JWT_SECRET,
    );
    const socket = makeSocket(token);
    const { fn: next, errors } = captureNext();
    middleware(socket, next);
    expect(errors).toHaveLength(0);
    expect(socket.data.userId).toBe(GUEST_ID);
    expect(socket.data.displayName).toBe("GuestPlayer");
    expect(socket.data.isGuest).toBe(true);
  });

  it("calls next with UNAUTHORIZED for an invalid guest token (bad HMAC)", () => {
    const store = makeStore();
    const middleware = createSocketAuthMiddleware(store);
    const token =
      "guest:" + Buffer.from("bad.payload.sig").toString("base64url");
    const socket = makeSocket(token);
    const { fn: next, errors } = captureNext();
    middleware(socket, next);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/UNAUTHORIZED/);
  });

  it("calls next with UNAUTHORIZED when session is not in store", () => {
    const store = new GuestSessionStore(); // empty — no session
    const middleware = createSocketAuthMiddleware(store);
    const token = createGuestToken(
      GUEST_ID,
      GAME_ID,
      Date.now() + 3_600_000,
      TEST_JWT_SECRET,
    );
    const socket = makeSocket(token);
    const { fn: next, errors } = captureNext();
    middleware(socket, next);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/UNAUTHORIZED/);
  });
});
