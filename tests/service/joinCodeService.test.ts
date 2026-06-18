import { describe, it, expect, vi, beforeEach } from "vitest";
import { JoinCodeService } from "../../src/backend/service/joinCodeService.js";
import type { JoinCodeRepository } from "../../src/backend/database/database.js";

function makeRepo(
  overrides: Partial<JoinCodeRepository> = {},
): JoinCodeRepository {
  return {
    createJoinCode: vi.fn<(code: string, gameId: string) => Promise<void>>(),
    getGameIdByCode: vi
      .fn<(code: string) => Promise<string | null>>()
      .mockResolvedValue(null),
    getCodeByGameId: vi
      .fn<(gameId: string) => Promise<string | null>>()
      .mockResolvedValue(null),
    deleteByGameId: vi.fn<(gameId: string) => Promise<void>>(),
    deleteExpired: vi
      .fn<(maxAgeMs: number) => Promise<number>>()
      .mockResolvedValue(0),
    ...overrides,
  };
}

const VALID_ALPHABET = new Set("ABCDEFGHJKMNPQRSTUVWXYZ23456789".split(""));

describe("JoinCodeService", () => {
  describe("generateCode", () => {
    it("generates a code exactly 4 characters long", async () => {
      const repo = makeRepo({
        createJoinCode: vi.fn().mockResolvedValue(undefined),
      });
      const service = new JoinCodeService(repo);
      const code = await service.generateCode("game-1");
      expect(code).toHaveLength(4);
    });

    it("generates a code using only characters from the reduced alphabet", async () => {
      const repo = makeRepo({
        createJoinCode: vi.fn().mockResolvedValue(undefined),
      });
      const service = new JoinCodeService(repo);

      // Generate many codes to exercise the alphabet sampling
      for (let i = 0; i < 50; i++) {
        const code = await service.generateCode(`game-${i}`);
        for (const ch of code) {
          expect(VALID_ALPHABET.has(ch)).toBe(true);
        }
      }
    });

    it("generates an uppercase code", async () => {
      const repo = makeRepo({
        createJoinCode: vi.fn().mockResolvedValue(undefined),
      });
      const service = new JoinCodeService(repo);
      const code = await service.generateCode("game-1");
      expect(code).toBe(code.toUpperCase());
    });

    it("retries on collision (unique constraint error) and succeeds", async () => {
      const createJoinCode = vi
        .fn<(code: string, gameId: string) => Promise<void>>()
        .mockRejectedValueOnce(
          new Error("duplicate key violates unique constraint"),
        )
        .mockResolvedValueOnce(undefined);

      const repo = makeRepo({ createJoinCode });
      const service = new JoinCodeService(repo);
      const code = await service.generateCode("game-1");

      expect(createJoinCode).toHaveBeenCalledTimes(2);
      expect(code).toHaveLength(4);
    });

    it("throws after 5 consecutive collision errors", async () => {
      const createJoinCode = vi
        .fn<(code: string, gameId: string) => Promise<void>>()
        .mockRejectedValue(
          new Error("duplicate key violates unique constraint"),
        );

      const repo = makeRepo({ createJoinCode });
      const service = new JoinCodeService(repo);

      await expect(service.generateCode("game-1")).rejects.toThrow(
        "Failed to generate unique join code after max retries",
      );
      expect(createJoinCode).toHaveBeenCalledTimes(5);
    });

    it("propagates non-collision errors immediately without retrying", async () => {
      const createJoinCode = vi
        .fn<(code: string, gameId: string) => Promise<void>>()
        .mockRejectedValue(new Error("connection refused"));

      const repo = makeRepo({ createJoinCode });
      const service = new JoinCodeService(repo);

      await expect(service.generateCode("game-1")).rejects.toThrow(
        "connection refused",
      );
      expect(createJoinCode).toHaveBeenCalledTimes(1);
    });

    it("populates the in-memory cache after successful generation", async () => {
      const getGameIdByCode = vi
        .fn<(code: string) => Promise<string | null>>()
        .mockResolvedValue(null);
      const repo = makeRepo({
        createJoinCode: vi.fn().mockResolvedValue(undefined),
        getGameIdByCode,
      });
      const service = new JoinCodeService(repo);
      const code = await service.generateCode("game-cache");

      // Should resolve from cache without hitting the DB
      const resolved = await service.resolveCode(code);
      expect(resolved).toBe("game-cache");
      expect(getGameIdByCode).not.toHaveBeenCalled();
    });

    it("populates the reverse cache after successful generation", async () => {
      const getCodeByGameId = vi
        .fn<(gameId: string) => Promise<string | null>>()
        .mockResolvedValue(null);
      const repo = makeRepo({
        createJoinCode: vi.fn().mockResolvedValue(undefined),
        getCodeByGameId,
      });
      const service = new JoinCodeService(repo);
      const code = await service.generateCode("game-reverse");

      // Should resolve from reverse cache without hitting the DB
      const resolved = await service.getCodeForGame("game-reverse");
      expect(resolved).toBe(code);
      expect(getCodeByGameId).not.toHaveBeenCalled();
    });
  });

  describe("resolveCode", () => {
    it("returns gameId for a known code from the DB", async () => {
      const repo = makeRepo({
        getGameIdByCode: vi.fn().mockResolvedValue("game-abc"),
      });
      const service = new JoinCodeService(repo);
      const result = await service.resolveCode("H7K3");
      expect(result).toBe("game-abc");
    });

    it("returns null for an unknown code", async () => {
      const repo = makeRepo({
        getGameIdByCode: vi.fn().mockResolvedValue(null),
      });
      const service = new JoinCodeService(repo);
      const result = await service.resolveCode("XXXX");
      expect(result).toBeNull();
    });

    it("normalizes lowercase input to uppercase before lookup", async () => {
      const getGameIdByCode = vi
        .fn<(code: string) => Promise<string | null>>()
        .mockResolvedValue("game-xyz");
      const repo = makeRepo({ getGameIdByCode });
      const service = new JoinCodeService(repo);

      await service.resolveCode("h7k3");

      expect(getGameIdByCode).toHaveBeenCalledWith("H7K3");
    });

    it("returns from cache without hitting DB when code was recently generated", async () => {
      const getGameIdByCode = vi
        .fn<(code: string) => Promise<string | null>>()
        .mockResolvedValue(null);
      const createJoinCode = vi.fn().mockResolvedValue(undefined);
      const repo = makeRepo({ createJoinCode, getGameIdByCode });
      const service = new JoinCodeService(repo);

      const code = await service.generateCode("game-1");
      const result = await service.resolveCode(code);

      expect(result).toBe("game-1");
      expect(getGameIdByCode).not.toHaveBeenCalled();
    });
  });

  describe("getCodeForGame", () => {
    it("returns the code for a known gameId from the DB", async () => {
      const repo = makeRepo({
        getCodeByGameId: vi.fn().mockResolvedValue("H7K3"),
      });
      const service = new JoinCodeService(repo);
      const result = await service.getCodeForGame("game-abc");
      expect(result).toBe("H7K3");
    });

    it("returns null for an unknown gameId", async () => {
      const repo = makeRepo({
        getCodeByGameId: vi.fn().mockResolvedValue(null),
      });
      const service = new JoinCodeService(repo);
      const result = await service.getCodeForGame("nonexistent-game");
      expect(result).toBeNull();
    });

    it("returns from reverse cache without hitting DB when code was recently generated", async () => {
      const getCodeByGameId = vi
        .fn<(gameId: string) => Promise<string | null>>()
        .mockResolvedValue(null);
      const repo = makeRepo({
        createJoinCode: vi.fn().mockResolvedValue(undefined),
        getCodeByGameId,
      });
      const service = new JoinCodeService(repo);

      const code = await service.generateCode("game-1");
      const result = await service.getCodeForGame("game-1");

      expect(result).toBe(code);
      expect(getCodeByGameId).not.toHaveBeenCalled();
    });
  });

  describe("deleteForGame", () => {
    it("calls deleteByGameId on the repository", async () => {
      const deleteByGameId = vi
        .fn<(gameId: string) => Promise<void>>()
        .mockResolvedValue(undefined);
      const repo = makeRepo({ deleteByGameId });
      const service = new JoinCodeService(repo);

      await service.deleteForGame("game-1");

      expect(deleteByGameId).toHaveBeenCalledWith("game-1");
    });

    it("removes the code from the forward cache", async () => {
      const getGameIdByCode = vi
        .fn<(code: string) => Promise<string | null>>()
        .mockResolvedValue(null);
      const repo = makeRepo({
        createJoinCode: vi.fn().mockResolvedValue(undefined),
        deleteByGameId: vi.fn().mockResolvedValue(undefined),
        getGameIdByCode,
      });
      const service = new JoinCodeService(repo);

      const code = await service.generateCode("game-del");
      await service.deleteForGame("game-del");

      // Forward cache entry removed — should fall through to DB
      await service.resolveCode(code);
      expect(getGameIdByCode).toHaveBeenCalledWith(code);
    });

    it("removes the gameId from the reverse cache", async () => {
      const getCodeByGameId = vi
        .fn<(gameId: string) => Promise<string | null>>()
        .mockResolvedValue(null);
      const repo = makeRepo({
        createJoinCode: vi.fn().mockResolvedValue(undefined),
        deleteByGameId: vi.fn().mockResolvedValue(undefined),
        getCodeByGameId,
      });
      const service = new JoinCodeService(repo);

      await service.generateCode("game-del");
      await service.deleteForGame("game-del");

      // Reverse cache entry removed — should fall through to DB
      await service.getCodeForGame("game-del");
      expect(getCodeByGameId).toHaveBeenCalledWith("game-del");
    });
  });

  describe("cleanupExpired", () => {
    it("delegates to deleteExpired with the provided maxAgeMs", async () => {
      const deleteExpired = vi
        .fn<(maxAgeMs: number) => Promise<number>>()
        .mockResolvedValue(3);
      const repo = makeRepo({ deleteExpired });
      const service = new JoinCodeService(repo);

      const count = await service.cleanupExpired(86400000);

      expect(deleteExpired).toHaveBeenCalledWith(86400000);
      expect(count).toBe(3);
    });

    it("returns 0 when no codes are expired", async () => {
      const repo = makeRepo({
        deleteExpired: vi.fn().mockResolvedValue(0),
      });
      const service = new JoinCodeService(repo);

      const count = await service.cleanupExpired(86400000);
      expect(count).toBe(0);
    });
  });
});
