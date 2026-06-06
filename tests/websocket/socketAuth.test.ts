import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";

const TEST_JWT_SECRET = "test-jwt-secret-for-unit-tests";

// Set the env var before importing the module (module-level code reads it on load)
process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;

const { socketAuthMiddleware } =
  await import("../../src/backend/websocket/socketAuth.js");
import type { TypedSocket } from "../../src/backend/websocket/socketServer.js";

function makeSocket(token?: unknown): TypedSocket {
  return {
    handshake: {
      auth: token !== undefined ? { token } : {},
    },
    data: {} as Record<string, unknown>,
  } as unknown as TypedSocket;
}

function validToken(overrides: object = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "test-user-uuid-1234",
    email: "test@example.com",
    role: "authenticated",
    aud: "authenticated",
    iat: now,
    exp: now + 3600,
    user_metadata: { display_name: "Test User" },
    ...overrides,
  };
  return jwt.sign(payload, TEST_JWT_SECRET, { algorithm: "HS256" });
}

function captureNext(): { fn: (err?: Error) => void; errors: Error[] } {
  const errors: Error[] = [];
  const fn = (err?: Error) => {
    if (err) errors.push(err);
  };
  return { fn, errors };
}

describe("socketAuthMiddleware", () => {
  describe("missing token", () => {
    it("calls next with Error when no token is provided", () => {
      const socket = makeSocket();
      const { fn: next, errors } = captureNext();
      socketAuthMiddleware(socket, next);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/UNAUTHORIZED/);
    });

    it("calls next with Error when token is not a string", () => {
      const socket = makeSocket(12345);
      const { fn: next, errors } = captureNext();
      socketAuthMiddleware(socket, next);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/UNAUTHORIZED/);
    });
  });

  describe("invalid token", () => {
    it("calls next with Error for a malformed token string", () => {
      const socket = makeSocket("not.a.valid.jwt");
      const { fn: next, errors } = captureNext();
      socketAuthMiddleware(socket, next);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/UNAUTHORIZED/);
    });

    it("calls next with Error for a token signed with the wrong secret", () => {
      const token = jwt.sign(
        {
          sub: "u1",
          email: "a@b.com",
          role: "authenticated",
          user_metadata: {},
        },
        "wrong-secret",
        { algorithm: "HS256" },
      );
      const socket = makeSocket(token);
      const { fn: next, errors } = captureNext();
      socketAuthMiddleware(socket, next);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/UNAUTHORIZED/);
    });

    it("calls next with Error for an expired token", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = jwt.sign(
        {
          sub: "u1",
          email: "a@b.com",
          role: "authenticated",
          aud: "authenticated",
          user_metadata: {},
          iat: now - 7200,
          exp: now - 3600,
        },
        TEST_JWT_SECRET,
        { algorithm: "HS256" },
      );
      const socket = makeSocket(token);
      const { fn: next, errors } = captureNext();
      socketAuthMiddleware(socket, next);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/UNAUTHORIZED/);
    });
  });

  describe("invalid role", () => {
    it("calls next with Error when role is 'anon'", () => {
      const token = validToken({ role: "anon" });
      const socket = makeSocket(token);
      const { fn: next, errors } = captureNext();
      socketAuthMiddleware(socket, next);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/UNAUTHORIZED/);
    });

    it("calls next with Error when role is empty string", () => {
      const token = validToken({ role: "" });
      const socket = makeSocket(token);
      const { fn: next, errors } = captureNext();
      socketAuthMiddleware(socket, next);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/UNAUTHORIZED/);
    });
  });

  describe("valid token", () => {
    it("sets socket.data.userId from the JWT sub claim", () => {
      const token = validToken({ sub: "expected-user-uuid" });
      const socket = makeSocket(token);
      const { fn: next } = captureNext();
      socketAuthMiddleware(socket, next);
      expect(socket.data.userId).toBe("expected-user-uuid");
    });

    it("sets socket.data.displayName from user_metadata.display_name", () => {
      const token = validToken({ user_metadata: { display_name: "Alice" } });
      const socket = makeSocket(token);
      const { fn: next } = captureNext();
      socketAuthMiddleware(socket, next);
      expect(socket.data.displayName).toBe("Alice");
    });

    it("falls back to email when display_name is absent", () => {
      const token = validToken({
        email: "fallback@example.com",
        user_metadata: {},
      });
      const socket = makeSocket(token);
      const { fn: next } = captureNext();
      socketAuthMiddleware(socket, next);
      expect(socket.data.displayName).toBe("fallback@example.com");
    });

    it("calls next() with no argument on success", () => {
      const token = validToken();
      const socket = makeSocket(token);
      const { fn: next, errors } = captureNext();
      socketAuthMiddleware(socket, next);
      expect(errors).toHaveLength(0);
    });
  });
});
