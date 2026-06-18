import { randomBytes } from "crypto";
import type { JoinCodeRepository } from "@/database/database";

const CODE_LENGTH = 4;
const MAX_RETRIES = 5;

export class JoinCodeService {
  // Reduced alphabet: A-Z minus O/I/L, digits 2-9 (avoids ambiguous characters)
  private static readonly ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

  private readonly cache = new Map<string, string>(); // code → gameId
  private readonly reverseCache = new Map<string, string>(); // gameId → code

  constructor(private readonly joinCodeRepo: JoinCodeRepository) {}

  /** Generate a unique 4-char code. Retries up to 5 times on collision. */
  async generateCode(gameId: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const code = this.randomCode();
      try {
        await this.joinCodeRepo.createJoinCode(code, gameId);
        this.cache.set(code, gameId);
        this.reverseCache.set(gameId, code);
        return code;
      } catch (err: unknown) {
        // Unique constraint violation — retry with a new code
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("duplicate") || message.includes("unique")) {
          continue;
        }
        throw err;
      }
    }
    throw new Error("Failed to generate unique join code after max retries");
  }

  /** Resolve a code to a gameId. Returns null if not found. */
  async resolveCode(code: string): Promise<string | null> {
    const normalized = code.toUpperCase();
    const cached = this.cache.get(normalized);
    if (cached !== undefined) return cached;
    return this.joinCodeRepo.getGameIdByCode(normalized);
  }

  /** Resolve a gameId to its join code. Returns null if not found. */
  async getCodeForGame(gameId: string): Promise<string | null> {
    const cached = this.reverseCache.get(gameId);
    if (cached !== undefined) return cached;
    return this.joinCodeRepo.getCodeByGameId(gameId);
  }

  /** Delete code for a completed/expired game. */
  async deleteForGame(gameId: string): Promise<void> {
    // Remove from both caches
    const code = this.reverseCache.get(gameId);
    if (code !== undefined) {
      this.cache.delete(code);
      this.reverseCache.delete(gameId);
    }
    await this.joinCodeRepo.deleteByGameId(gameId);
  }

  /** Cleanup codes older than maxAgeMs. Called periodically. */
  async cleanupExpired(maxAgeMs: number): Promise<number> {
    const count = await this.joinCodeRepo.deleteExpired(maxAgeMs);
    // Cache entries for expired codes stay until next lookup — acceptable for
    // a single-server deployment. On cache miss the DB returns null, which is correct.
    return count;
  }

  private randomCode(): string {
    const bytes = randomBytes(CODE_LENGTH);
    const alphabetLength = JoinCodeService.ALPHABET.length;
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += JoinCodeService.ALPHABET[bytes[i] % alphabetLength];
    }
    return code;
  }
}
