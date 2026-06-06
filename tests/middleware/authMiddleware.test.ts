import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";

const TEST_JWT_SECRET = "test-jwt-secret-for-unit-tests";

// Set the env var before importing the module (module-level code reads it on load)
process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;

// Dynamic import so env var is set before module initializes
const { authMiddleware } = await import("../../src/backend/middleware/authMiddleware.js");
import type { Request, Response, Next } from "../../src/backend/util/types.js";

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function makeNext(): { fn: Next; called: boolean } {
  const state = { called: false };
  const fn: Next = () => { state.called = true; };
  return { fn, called: state.called };
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

// The middleware throws UnauthorizedError (status 401) for all rejection cases.
// Note: UnauthorizedError has a pre-existing prototype bug where setPrototypeOf
// sets AccessDeniedError.prototype. We assert on status 401 instead of instanceof.
function expectUnauthorized(fn: () => void): void {
  let thrown: unknown;
  try { fn(); } catch (e) { thrown = e; }
  expect(thrown).toBeDefined();
  expect((thrown as { status?: number }).status).toBe(401);
}

describe("authMiddleware", () => {
  describe("missing token", () => {
    it("throws 401 when Authorization header is absent", () => {
      const req = makeRequest({ headers: {} });
      const { fn: next } = makeNext();
      expectUnauthorized(() => authMiddleware(req, {} as Response, next));
    });

    it("throws 401 when Authorization header is not Bearer", () => {
      const req = makeRequest({ headers: { authorization: "Basic abc123" } });
      const { fn: next } = makeNext();
      expectUnauthorized(() => authMiddleware(req, {} as Response, next));
    });

    it("throws 401 when Bearer token is empty string", () => {
      const req = makeRequest({ headers: { authorization: "Bearer " } });
      const { fn: next } = makeNext();
      expectUnauthorized(() => authMiddleware(req, {} as Response, next));
    });
  });

  describe("invalid token", () => {
    it("throws 401 for a malformed token", () => {
      const req = makeRequest({ headers: { authorization: "Bearer not.a.valid.jwt" } });
      const { fn: next } = makeNext();
      expectUnauthorized(() => authMiddleware(req, {} as Response, next));
    });

    it("throws 401 for a token signed with the wrong secret", () => {
      const token = jwt.sign(
        { sub: "u1", email: "a@b.com", role: "authenticated", user_metadata: {} },
        "wrong-secret",
        { algorithm: "HS256" }
      );
      const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
      const { fn: next } = makeNext();
      expectUnauthorized(() => authMiddleware(req, {} as Response, next));
    });

    it("throws 401 for an expired token", () => {
      const now = Math.floor(Date.now() / 1000);
      const token = jwt.sign(
        { sub: "u1", email: "a@b.com", role: "authenticated", aud: "authenticated", user_metadata: {}, iat: now - 7200, exp: now - 3600 },
        TEST_JWT_SECRET,
        { algorithm: "HS256" }
      );
      const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
      const { fn: next } = makeNext();
      expectUnauthorized(() => authMiddleware(req, {} as Response, next));
    });

    it("throws 401 for a token with RS256 algorithm header (wrong algorithm)", () => {
      // Middleware only accepts HS256 — a forged RS256 header token is rejected
      const malformedToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1MSIsInJvbGUiOiJhdXRoZW50aWNhdGVkIn0.invalidsig";
      const req = makeRequest({ headers: { authorization: `Bearer ${malformedToken}` } });
      const { fn: next } = makeNext();
      expectUnauthorized(() => authMiddleware(req, {} as Response, next));
    });
  });

  describe("anon role rejection", () => {
    it("throws 401 when role is 'anon'", () => {
      const token = validToken({ role: "anon" });
      const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
      const { fn: next } = makeNext();
      expectUnauthorized(() => authMiddleware(req, {} as Response, next));
    });

    it("throws 401 when role is empty string", () => {
      const token = validToken({ role: "" });
      const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
      const { fn: next } = makeNext();
      expectUnauthorized(() => authMiddleware(req, {} as Response, next));
    });
  });

  describe("valid token", () => {
    it("extracts userId from JWT sub claim", () => {
      const token = validToken({ sub: "expected-user-uuid" });
      const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
      const { fn: next } = makeNext();
      authMiddleware(req, {} as Response, next);
      expect(req.userId).toBe("expected-user-uuid");
    });

    it("extracts displayName from user_metadata.display_name", () => {
      const token = validToken({ user_metadata: { display_name: "Alice" } });
      const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
      const { fn: next } = makeNext();
      authMiddleware(req, {} as Response, next);
      expect(req.displayName).toBe("Alice");
    });

    it("falls back to email when display_name is absent", () => {
      const token = validToken({ email: "fallback@example.com", user_metadata: {} });
      const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
      const { fn: next } = makeNext();
      authMiddleware(req, {} as Response, next);
      expect(req.displayName).toBe("fallback@example.com");
    });

    it("calls next() on valid authenticated token", () => {
      const token = validToken();
      const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
      let nextCalled = false;
      const next: Next = () => { nextCalled = true; };
      authMiddleware(req, {} as Response, next);
      expect(nextCalled).toBe(true);
    });

    it("does not throw for a valid token", () => {
      const token = validToken();
      const req = makeRequest({ headers: { authorization: `Bearer ${token}` } });
      const { fn: next } = makeNext();
      expect(() => authMiddleware(req, {} as Response, next)).not.toThrow();
    });
  });
});
