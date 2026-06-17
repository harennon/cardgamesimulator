/**
 * RLS integration tests (LLD 12 section 10, integration tests 4-6 and security tests 1-3).
 *
 * These tests talk directly to PostgREST (the Supabase HTTP API) using the anon key,
 * NOT through the Express backend. They verify that RLS policies correctly restrict
 * what authenticated and unauthenticated clients can see and mutate.
 *
 * Run with: npm run test:integration
 * Requires: supabase start (local Supabase stack)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { getSupabaseUrl, getSupabaseAnonKey } from "./helpers/env.js";
import { SupabaseDB } from "../../src/backend/database/supabaseDb.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnonClient(): SupabaseClient {
  return createClient(getSupabaseUrl(), getSupabaseAnonKey());
}

/**
 * Creates an anon-key client and signs up a fresh user so the client is
 * authenticated with that user's JWT for all subsequent PostgREST calls.
 */
async function makeAuthenticatedClient(): Promise<{
  client: SupabaseClient;
  userId: string;
}> {
  const client = makeAnonClient();
  const email = `rls-test-${randomUUID()}@integration.test`;
  const password = "TestPassword123!";

  const { data, error } = await client.auth.signUp({ email, password });
  if (error || !data.session) {
    throw new Error(
      `Failed to create test user for RLS tests: ${error?.message ?? "no session"}. ` +
        `Is Supabase running? Run: supabase start`,
    );
  }

  return { client, userId: data.user!.id };
}

/**
 * Uses the backend service-role client to create a game row directly in the DB,
 * bypassing RLS. This seeds test data without going through the Express API.
 */
async function seedGame(creatorId: string): Promise<{ gameId: string }> {
  const gameId = randomUUID();
  await SupabaseDB.INSTANCE.createGame(
    gameId,
    "big2",
    creatorId,
    4,
    "TestPlayer",
    null,
  );
  return { gameId };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  // SupabaseDB.INSTANCE needs to be initialized before seedGame() can be called.
  // setupEnv.ts (vitest setup file) has already loaded env vars.
  SupabaseDB.INSTANCE.initialize();
});

// ---------------------------------------------------------------------------
// Integration test 4: RLS SELECT isolation for games
// ---------------------------------------------------------------------------

describe("RLS: games SELECT isolation", () => {
  it("authenticated user can SELECT their own games via direct PostgREST", async () => {
    const { client, userId } = await makeAuthenticatedClient();
    const { gameId } = await seedGame(userId);

    const { data, error } = await client
      .from("games")
      .select("game_id")
      .eq("game_id", gameId);

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBe(1);
    expect(data![0]!.game_id).toBe(gameId);
  });

  it("authenticated user cannot SELECT another user's games via direct PostgREST", async () => {
    // ownerClient creates a game, otherClient tries to read it
    const { userId: ownerId } = await makeAuthenticatedClient();
    const { client: otherClient } = await makeAuthenticatedClient();

    const { gameId } = await seedGame(ownerId);

    const { data, error } = await otherClient
      .from("games")
      .select("game_id")
      .eq("game_id", gameId);

    // RLS should return zero rows (not an error — PostgREST filters silently)
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration test 5: RLS blocks UPDATE on games
// ---------------------------------------------------------------------------

describe("RLS: games UPDATE blocked", () => {
  it("authenticated user cannot UPDATE games via direct PostgREST", async () => {
    const { client, userId } = await makeAuthenticatedClient();
    const { gameId } = await seedGame(userId);

    // Even though this user is a player in the game, there is no UPDATE policy
    // so RLS silently matches 0 rows — the update has no effect.
    const { data, error } = await client
      .from("games")
      .update({ status: "STARTED" })
      .eq("game_id", gameId)
      .select();

    // No error returned, but no rows updated (RLS filtered them out)
    expect(error).toBeNull();
    expect(data).toEqual([]);

    // Verify the game status is still CREATED via service-role
    const game = await SupabaseDB.INSTANCE.getGame(gameId);
    expect(game!.status).toBe("CREATED");
  });
});

// ---------------------------------------------------------------------------
// Integration test 6: RLS stats isolation
// ---------------------------------------------------------------------------

describe("RLS: player_stats SELECT isolation", () => {
  it("authenticated user cannot read another user's stats via direct PostgREST", async () => {
    const { userId: ownerUserId } = await makeAuthenticatedClient();
    const { client: otherClient } = await makeAuthenticatedClient();

    // Seed stats for ownerUserId via service-role
    await SupabaseDB.INSTANCE.incrementStats(ownerUserId, {
      gamesPlayed: 1,
      gamesWon: 1,
      gamesLost: 0,
      totalScore: 5,
    });

    // otherClient tries to read ownerUserId's stats
    const { data, error } = await otherClient
      .from("player_stats")
      .select("*")
      .eq("user_id", ownerUserId);

    // RLS filters silently — zero rows returned, no error
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Security test 1: Anon key cannot INSERT into games
// ---------------------------------------------------------------------------

describe("Security: anon INSERT into games is blocked", () => {
  it("unauthenticated anon key client cannot INSERT into games", async () => {
    const anonClient = makeAnonClient();
    // Do NOT sign in — this client is unauthenticated

    const { error } = await anonClient.from("games").insert({
      game_id: randomUUID(),
      game_type: "big2",
      player_ids: [],
      player_display_names: {},
      max_players: 4,
      status: "CREATED",
      state: {},
    });

    expect(error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Security test 2: increment_player_stats RPC cannot be called by authenticated user
// ---------------------------------------------------------------------------

describe("Security: increment_player_stats RPC restricted to service_role", () => {
  it("authenticated user cannot call increment_player_stats RPC directly", async () => {
    const { client, userId } = await makeAuthenticatedClient();

    const { data, error } = await client.rpc("increment_player_stats", {
      p_user_id: userId,
      p_games_played: 1,
      p_games_won: 1,
      p_games_lost: 0,
      p_total_score: 5,
    });

    // REVOKE EXECUTE blocks the call — PostgREST returns an error OR
    // the function is not visible in the schema cache (both indicate blocked access).
    // If no error, verify the stats were NOT actually modified.
    if (error) {
      expect(error).not.toBeNull();
    } else {
      // PostgREST may swallow the error — verify no stats were written
      const stats = await SupabaseDB.INSTANCE.getStats(userId);
      expect(stats).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Security test 3: authenticated user cannot UPDATE another user's game
// ---------------------------------------------------------------------------

describe("Security: authenticated user cannot UPDATE another user's game", () => {
  it("cannot UPDATE a game the authenticated user is not a player in", async () => {
    const { userId: ownerId } = await makeAuthenticatedClient();
    const { client: attackerClient } = await makeAuthenticatedClient();

    const { gameId } = await seedGame(ownerId);

    const { data, error } = await attackerClient
      .from("games")
      .update({ status: "STARTED" })
      .eq("game_id", gameId)
      .select();

    // No UPDATE policy exists — RLS silently filters to 0 matching rows
    expect(error).toBeNull();
    expect(data).toEqual([]);

    // Verify the game was not actually modified
    const game = await SupabaseDB.INSTANCE.getGame(gameId);
    expect(game!.status).toBe("CREATED");
  });
});
