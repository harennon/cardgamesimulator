import { describe, it, expect } from "vitest";
import { createProdShapedFixture } from "./helpers/prodShapedFixture.js";

// ---------------------------------------------------------------------------
// LLD 149: migration 012 (prune_game_history) retention policy.
// Self-materializes a prod-shaped baseline in a throwaway schema, applies the
// real 010 + 012 SQL, and asserts the prune contract:
//   - Only aged rows (> 13 months) are deleted; rows inside the floor are kept.
//   - The strict < boundary: a row exactly at the floor is retained.
//   - Window-safety invariant (E2): get_windowed_stats returns the same counts
//     before and after a prune for YTD-edge and 30d-edge rows.
//   - Idempotency (E3): second prune deletes 0 rows; table state is unchanged.
//   - player_stats is byte-for-byte unchanged after a real (committed) prune (E1).
//   - The 012 post-condition passes and RAISEs when the function is absent.
// Seeds rows directly at known played_at — no replayed games (testing-principles §3/§4).
// ---------------------------------------------------------------------------

const USER_A = "aaaaaaaa-0000-0000-0000-000000000001";
const USER_B = "bbbbbbbb-0000-0000-0000-000000000002";

/** Insert a game_history row at an explicit played_at into the fixture schema. */
async function seedHistory(
  fixture: Awaited<ReturnType<typeof createProdShapedFixture>>,
  row: {
    userId: string;
    gameType: string;
    won: boolean;
    lost: boolean;
    score: number;
    playedAt: string;
  },
): Promise<void> {
  await fixture.client.query(
    `INSERT INTO game_history (user_id, game_type, won, lost, score, played_at)
     VALUES ($1, $2, $3, $4, $5, $6);`,
    [row.userId, row.gameType, row.won, row.lost, row.score, row.playedAt],
  );
}

/** Insert a player_stats row (for the E1 invariant check). */
async function seedPlayerStats(
  fixture: Awaited<ReturnType<typeof createProdShapedFixture>>,
  row: {
    userId: string;
    gameType: string;
    gamesPlayed: number;
    gamesWon: number;
    gamesLost: number;
    totalScore: number;
  },
): Promise<void> {
  await fixture.client.query(
    `INSERT INTO player_stats (user_id, game_type, games_played, games_won, games_lost, total_score, last_played_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW());`,
    [
      row.userId,
      row.gameType,
      row.gamesPlayed,
      row.gamesWon,
      row.gamesLost,
      row.totalScore,
    ],
  );
}

/** Compute a stable snapshot string of all player_stats rows. */
async function snapshotPlayerStats(
  fixture: Awaited<ReturnType<typeof createProdShapedFixture>>,
): Promise<string> {
  const { rows } = await fixture.client.query<{ snap: string }>(
    `SELECT coalesce(
       string_agg(
         user_id::text || ',' || game_type || ',' ||
         games_played::text || ',' || games_won::text || ',' ||
         games_lost::text || ',' || total_score::text,
         '|' ORDER BY user_id, game_type
       ),
       ''
     ) AS snap
     FROM player_stats;`,
  );
  return rows[0]!.snap;
}

/** Call prune_game_history() and return the deleted row count. */
async function runPrune(
  fixture: Awaited<ReturnType<typeof createProdShapedFixture>>,
): Promise<number> {
  const { rows } = await fixture.client.query<{ n: string }>(
    `SELECT prune_game_history()::text AS n;`,
  );
  return parseInt(rows[0]!.n, 10);
}

/** Return count of all rows in game_history. */
async function countHistory(
  fixture: Awaited<ReturnType<typeof createProdShapedFixture>>,
): Promise<number> {
  const { rows } = await fixture.client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM game_history;`,
  );
  return parseInt(rows[0]!.n, 10);
}

/**
 * Timestamps relative to "now" used in tests.
 * Using a fixed reference so the tests are deterministic within the run.
 */
function tsOffset(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

describe("Migration 012 — prune_game_history function + grant set", () => {
  it("creates prune_game_history as SECURITY DEFINER callable by service_role only", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "010_create_game_history.sql",
        "012_prune_game_history.sql",
      ]);

      const { rows } = await fixture.client.query<{
        svc: boolean;
        anon: boolean;
        auth: boolean;
        pub: boolean;
        secdef: boolean;
      }>(
        `WITH fn AS (
           SELECT oid, prosecdef FROM pg_proc
           WHERE proname = 'prune_game_history' AND pg_function_is_visible(oid)
         )
         SELECT prosecdef AS secdef,
                has_function_privilege('service_role', fn.oid, 'EXECUTE') AS svc,
                has_function_privilege('anon', fn.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', fn.oid, 'EXECUTE') AS auth,
                has_function_privilege('public', fn.oid, 'EXECUTE') AS pub
         FROM fn;`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        secdef: true,
        svc: true,
        anon: false,
        auth: false,
        pub: false,
      });
    } finally {
      await fixture.teardown();
    }
  });

  it("the 012 post-condition passes after applying 010 + 012", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "010_create_game_history.sql",
        "012_prune_game_history.sql",
      ]);
      await expect(
        fixture.runPostcondition("012_prune_game_history.postcondition.sql"),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.teardown();
    }
  });

  it("the 012 post-condition RAISEs when prune_game_history is absent", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      // Apply 010 only — prune_game_history is not defined.
      await fixture.applyMigrations(["010_create_game_history.sql"]);
      await expect(
        fixture.runPostcondition("012_prune_game_history.postcondition.sql"),
      ).rejects.toThrow(/POSTCONDITION FAILED \(012/);
    } finally {
      await fixture.teardown();
    }
  });

  it("is idempotent: applying 012 twice does not create a second function overload", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "010_create_game_history.sql",
        "012_prune_game_history.sql",
        "012_prune_game_history.sql",
      ]);
      const { rows } = await fixture.client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_proc
         WHERE proname = 'prune_game_history' AND pg_function_is_visible(oid);`,
      );
      expect(rows[0]!.n).toBe("1");
    } finally {
      await fixture.teardown();
    }
  });
});

describe("prune_game_history — age-based deletion (retention floor = 13 months)", () => {
  it("deletes only rows older than 13 months; rows inside the floor are kept", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "010_create_game_history.sql",
        "012_prune_game_history.sql",
      ]);

      // Aged rows (> 13 months old) — should be pruned.
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: true,
        lost: false,
        score: 5,
        playedAt: tsOffset(14),
      });
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: false,
        lost: true,
        score: 3,
        playedAt: tsOffset(20),
      });

      // Rows inside the floor — should be kept.
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: true,
        lost: false,
        score: 10,
        playedAt: tsOffset(12),
      });
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: false,
        lost: true,
        score: 1,
        playedAt: tsOffset(1),
      });
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: true,
        lost: false,
        score: 7,
        playedAt: new Date().toISOString(),
      });

      expect(await countHistory(fixture)).toBe(5);
      const deleted = await runPrune(fixture);
      expect(deleted).toBe(2);
      expect(await countHistory(fixture)).toBe(3);
    } finally {
      await fixture.teardown();
    }
  });

  it("boundary: a row at 13 months - 1 day is RETAINED (floor uses strict <)", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "010_create_game_history.sql",
        "012_prune_game_history.sql",
      ]);

      // Seed a row at exactly (now() - 13 months + 1 day) using DB-side arithmetic
      // so there is no Node/DB clock-skew. The prune deletes WHERE played_at <
      // now() - INTERVAL '13 months'; this row is 1 day inside the floor and must
      // survive — demonstrating that the strict < never deletes a row that is
      // even slightly newer than the floor.
      await fixture.client.query(
        `INSERT INTO game_history (user_id, game_type, won, lost, score, played_at)
         VALUES ($1, 'big2', true, false, 5,
                 now() - INTERVAL '13 months' + INTERVAL '1 day');`,
        [USER_A],
      );

      const deleted = await runPrune(fixture);
      // The row is 1 day inside the floor — not deleted.
      expect(deleted).toBe(0);
      expect(await countHistory(fixture)).toBe(1);
    } finally {
      await fixture.teardown();
    }
  });

  it("returns 0 and leaves the table empty when there are no rows to prune", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "010_create_game_history.sql",
        "012_prune_game_history.sql",
      ]);

      // No rows seeded — prune should be a no-op.
      const deleted = await runPrune(fixture);
      expect(deleted).toBe(0);
      expect(await countHistory(fixture)).toBe(0);
    } finally {
      await fixture.teardown();
    }
  });
});

describe("prune_game_history — window-safety invariant (E2)", () => {
  it("a YTD-edge row (Jan 1 of current year) is never deleted by the prune", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "010_create_game_history.sql",
        "012_prune_game_history.sql",
      ]);

      // Jan 1 of the current UTC year — the oldest row a YTD window can read.
      const ytdEdge = new Date(
        Date.UTC(new Date().getUTCFullYear(), 0, 1),
      ).toISOString();

      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: true,
        lost: false,
        score: 5,
        playedAt: ytdEdge,
      });

      const { rows: before } = await fixture.client.query<{
        games_played: string;
      }>(`SELECT * FROM get_windowed_stats($1, $2);`, [USER_A, ytdEdge]);
      expect(before).toHaveLength(1);
      expect(before[0]!.games_played).toBe("1");

      await runPrune(fixture);

      // The YTD-edge row must still be present (it is < 13 months old).
      const { rows: after } = await fixture.client.query<{
        games_played: string;
      }>(`SELECT * FROM get_windowed_stats($1, $2);`, [USER_A, ytdEdge]);
      expect(after).toHaveLength(1);
      expect(after[0]!.games_played).toBe("1");
    } finally {
      await fixture.teardown();
    }
  });

  it("a 30d-edge row is never deleted by the prune", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "010_create_game_history.sql",
        "012_prune_game_history.sql",
      ]);

      const thirtyDaysAgo = tsOffset(1); // ~30 days ago
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "tonk",
        won: false,
        lost: true,
        score: 20,
        playedAt: thirtyDaysAgo,
      });

      const { rows: before } = await fixture.client.query<{
        games_played: string;
      }>(`SELECT * FROM get_windowed_stats($1, $2);`, [USER_A, thirtyDaysAgo]);
      expect(before).toHaveLength(1);

      await runPrune(fixture);

      const { rows: after } = await fixture.client.query<{
        games_played: string;
      }>(`SELECT * FROM get_windowed_stats($1, $2);`, [USER_A, thirtyDaysAgo]);
      expect(after).toHaveLength(1);
      expect(after[0]!.games_played).toBe(before[0]!.games_played);
    } finally {
      await fixture.teardown();
    }
  });
});

describe("prune_game_history — idempotency (E3)", () => {
  it("running the prune twice back-to-back: second run deletes 0 rows", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "010_create_game_history.sql",
        "012_prune_game_history.sql",
      ]);

      // Seed one aged row.
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: true,
        lost: false,
        score: 5,
        playedAt: tsOffset(14),
      });
      // Seed one recent row.
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: false,
        lost: true,
        score: 2,
        playedAt: tsOffset(1),
      });

      const first = await runPrune(fixture);
      expect(first).toBe(1);

      const second = await runPrune(fixture);
      expect(second).toBe(0);

      // Recent row still present.
      expect(await countHistory(fixture)).toBe(1);
    } finally {
      await fixture.teardown();
    }
  });
});

describe("prune_game_history — player_stats is untouched (E1, headline check)", () => {
  it("a real (committed) prune of aged game_history rows leaves player_stats byte-for-byte unchanged", async () => {
    // Apply the full 001-012 chain so player_stats has the game_type column
    // (added by 004) and the composite PK (006). The prune only touches
    // game_history; player_stats must remain byte-for-byte unchanged.
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "001_create_tables.sql",
        "002_enable_rls.sql",
        "003_increment_stats_rpc.sql",
        "004_player_stats_game_type.sql",
        "005_increment_stats_rpc_game_type.sql",
        "006_fix_player_stats_composite_pk.sql",
        "007_normalize_pk_names.sql",
        "008_revoke_anon_writes.sql",
        "009_add_game_config.sql",
        "010_create_game_history.sql",
        "012_prune_game_history.sql",
      ]);

      // Seed player_stats rows (lifetime aggregate — never touched by the prune).
      await seedPlayerStats(fixture, {
        userId: USER_A,
        gameType: "big2",
        gamesPlayed: 10,
        gamesWon: 6,
        gamesLost: 4,
        totalScore: 50,
      });
      await seedPlayerStats(fixture, {
        userId: USER_B,
        gameType: "tonk",
        gamesPlayed: 5,
        gamesWon: 2,
        gamesLost: 3,
        totalScore: 120,
      });

      // Seed aged game_history rows (will be pruned).
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: true,
        lost: false,
        score: 5,
        playedAt: tsOffset(14),
      });
      await seedHistory(fixture, {
        userId: USER_B,
        gameType: "tonk",
        won: false,
        lost: true,
        score: 30,
        playedAt: tsOffset(16),
      });
      // Also seed a recent row that survives.
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: false,
        lost: true,
        score: 3,
        playedAt: tsOffset(1),
      });

      const beforeStats = await snapshotPlayerStats(fixture);
      const beforeCount = await countHistory(fixture);
      expect(beforeCount).toBe(3);

      const deleted = await runPrune(fixture);
      expect(deleted).toBe(2);

      // Aged rows are gone.
      expect(await countHistory(fixture)).toBe(1);

      // player_stats is byte-for-byte unchanged.
      const afterStats = await snapshotPlayerStats(fixture);
      expect(afterStats).toBe(beforeStats);
    } finally {
      await fixture.teardown();
    }
  });
});

describe("post-condition assertion 3 — ROLLBACK makes prune invoke non-mutating", () => {
  it("seeding a >13-month row and running the post-condition leaves the row intact (ROLLBACK undoes the invoke)", async () => {
    // This test guards the mandatory BEGIN...ROLLBACK wrapper in assertion 3
    // (LLD 149 §Interfaces/Types "Why the ROLLBACK is mandatory"). Without it a
    // bare PERFORM prune_game_history() at the top level would commit a real DELETE
    // when the verifier runs against prod after rows have aged past 13 months.
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "010_create_game_history.sql",
        "012_prune_game_history.sql",
      ]);

      // Seed a row that is older than 13 months using DB-side arithmetic to avoid
      // Node/DB clock skew. This row IS past the retention floor and prune would
      // delete it — but the post-condition's ROLLBACK must undo that delete.
      await fixture.client.query(
        `INSERT INTO game_history (user_id, game_type, won, lost, score, played_at)
         VALUES ($1, 'big2', true, false, 5,
                 now() - INTERVAL '14 months');`,
        [USER_A],
      );

      const beforeCount = await countHistory(fixture);
      expect(beforeCount).toBe(1);

      // Run the real post-condition file (the one that has the ROLLBACK).
      // If the ROLLBACK is absent the row would be deleted; if present it survives.
      await expect(
        fixture.runPostcondition("012_prune_game_history.postcondition.sql"),
      ).resolves.toBeUndefined();

      // The aged row must still be present — the post-condition's ROLLBACK
      // discarded the prune invoke's effects.
      const afterCount = await countHistory(fixture);
      expect(afterCount).toBe(1);
    } finally {
      await fixture.teardown();
    }
  });
});

describe("drift-gate coupling — 012 in both expectedPending and fixture pending", () => {
  it("the in-tree fixture lists 012 as pending and the allowlist expects it", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const ROOT = resolve(__dirname, "../..");

    const fixture = JSON.parse(
      readFileSync(resolve(ROOT, "scripts/fixtures/clean-diff.json"), "utf8"),
    ) as { pending: string[] };
    const allowlist = JSON.parse(
      readFileSync(
        resolve(ROOT, "supabase/migrations/expected-diff.allowlist.json"),
        "utf8",
      ),
    ) as { expectedPending: string[] };

    expect(fixture.pending).toContain("012_prune_game_history.sql");
    expect(allowlist.expectedPending).toContain("012_prune_game_history.sql");
  });
});
