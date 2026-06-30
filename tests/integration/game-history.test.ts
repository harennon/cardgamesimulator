import { describe, it, expect } from "vitest";
import { createProdShapedFixture } from "./helpers/prodShapedFixture.js";

// ---------------------------------------------------------------------------
// LLD 101: migration 010 (game_history table + get_windowed_stats RPC) and the
// windowed-aggregation contract. Self-materializes a prod-shaped baseline in a
// throwaway schema, runs the REAL 010 SQL, and asserts: table shape + grant set,
// the 010 post-condition (incl. RAISE-when-absent), append-only inserts, the
// windowed aggregation (inclusive >= boundary, empty result, no cross-user
// leakage), and getTrackingSince. Seeds rows directly at known played_at
// timestamps — no replayed games (testing-principles §3/§4). Credential-free:
// local supabase start only, no prod connection (LLD 77 §9).
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

describe("Migration 010 game_history table + RPC", () => {
  it("creates the table with the expected columns and types (prod-shaped baseline)", async () => {
    const fixture = await createProdShapedFixture({
      baseline: "typeorm-era",
      drift: { pkey1ConstraintNames: true },
    });
    try {
      await fixture.applyMigrations(["010_create_game_history.sql"]);

      const { rows } = await fixture.client.query<{
        attname: string;
        type: string;
        notnull: boolean;
      }>(
        `SELECT a.attname,
                format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS notnull
         FROM pg_attribute a
         WHERE a.attrelid = to_regclass('game_history')
           AND a.attnum > 0
           AND NOT a.attisdropped
         ORDER BY a.attnum;`,
      );

      const byName = new Map(rows.map((r) => [r.attname, r]));
      expect(byName.get("id")!.type).toBe("uuid");
      expect(byName.get("user_id")!.type).toBe("uuid");
      expect(byName.get("user_id")!.notnull).toBe(true);
      expect(byName.get("game_type")!.type).toBe("character varying(50)");
      expect(byName.get("won")!.type).toBe("boolean");
      expect(byName.get("lost")!.type).toBe("boolean");
      expect(byName.get("score")!.type).toBe("integer");
      expect(byName.get("played_at")!.type).toBe("timestamp with time zone");
    } finally {
      await fixture.teardown();
    }
  });

  it("grants service_role full access and anon/authenticated SELECT-only (no write DML)", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations(["010_create_game_history.sql"]);

      const { rows } = await fixture.client.query<{
        role: string;
        sel: boolean;
        ins: boolean;
        upd: boolean;
        del: boolean;
      }>(
        `SELECT r AS role,
                has_table_privilege(r, to_regclass('game_history'), 'SELECT') AS sel,
                has_table_privilege(r, to_regclass('game_history'), 'INSERT') AS ins,
                has_table_privilege(r, to_regclass('game_history'), 'UPDATE') AS upd,
                has_table_privilege(r, to_regclass('game_history'), 'DELETE') AS del
         FROM unnest(ARRAY['service_role','authenticated','anon']) AS r;`,
      );
      const byRole = new Map(rows.map((r) => [r.role, r]));

      // service_role: full access.
      expect(byRole.get("service_role")).toMatchObject({
        sel: true,
        ins: true,
        upd: true,
        del: true,
      });
      // anon + authenticated: SELECT only, no write DML.
      for (const role of ["anon", "authenticated"]) {
        expect(byRole.get(role)).toMatchObject({
          sel: true,
          ins: false,
          upd: false,
          del: false,
        });
      }
    } finally {
      await fixture.teardown();
    }
  });

  it("get_windowed_stats is service_role-only (REVOKEd from PUBLIC/anon/authenticated)", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations(["010_create_game_history.sql"]);

      const { rows } = await fixture.client.query<{
        svc: boolean;
        anon: boolean;
        auth: boolean;
        pub: boolean;
      }>(
        `WITH fn AS (
           SELECT oid FROM pg_proc
           WHERE proname = 'get_windowed_stats' AND pg_function_is_visible(oid)
         )
         SELECT has_function_privilege('service_role', fn.oid, 'EXECUTE') AS svc,
                has_function_privilege('anon', fn.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', fn.oid, 'EXECUTE') AS auth,
                has_function_privilege('public', fn.oid, 'EXECUTE') AS pub
         FROM fn;`,
      );
      expect(rows[0]).toEqual({
        svc: true,
        anon: false,
        auth: false,
        pub: false,
      });
    } finally {
      await fixture.teardown();
    }
  });

  it("the 010 post-condition passes after applying 010 and RAISEs when the table is absent", async () => {
    const present = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await present.applyMigrations(["010_create_game_history.sql"]);
      await expect(
        present.runPostcondition("010_create_game_history.postcondition.sql"),
      ).resolves.toBeUndefined();
    } finally {
      await present.teardown();
    }

    const absent = await createProdShapedFixture({ baseline: "fresh" });
    try {
      // 010 not applied → the table/RPC are missing → the post-condition RAISEs.
      await expect(
        absent.runPostcondition("010_create_game_history.postcondition.sql"),
      ).rejects.toThrow(/POSTCONDITION FAILED \(010/);
    } finally {
      await absent.teardown();
    }
  });

  it("is idempotent: applying 010 twice is a no-op (IF NOT EXISTS / OR REPLACE)", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations(["010_create_game_history.sql"]);
      await fixture.applyMigrations(["010_create_game_history.sql"]);
      await expect(
        fixture.runPostcondition("010_create_game_history.postcondition.sql"),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.teardown();
    }
  });

  it("is append-only: two completions in the same second produce two rows (surrogate PK, no collision)", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations(["010_create_game_history.sql"]);

      const ts = "2026-06-30T12:00:00.000Z";
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: true,
        lost: false,
        score: 5,
        playedAt: ts,
      });
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: false,
        lost: true,
        score: 3,
        playedAt: ts,
      });

      const { rows } = await fixture.client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM game_history WHERE user_id = $1;`,
        [USER_A],
      );
      expect(rows[0]!.n).toBe("2");
    } finally {
      await fixture.teardown();
    }
  });
});

describe("get_windowed_stats aggregation (LLD 101 A3)", () => {
  it("aggregates grouped by game_type and applies the inclusive >= date filter (E7), excluding older rows", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations(["010_create_game_history.sql"]);

      // Cutoff for the test (the backend would compute this).
      const since = "2026-06-01T00:00:00.000Z";

      // Inside the window (>= cutoff): big2 win + big2 loss + tonk loss.
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: true,
        lost: false,
        score: 5,
        playedAt: "2026-06-10T00:00:00.000Z",
      });
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: false,
        lost: true,
        score: 3,
        playedAt: "2026-06-20T00:00:00.000Z",
      });
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "tonk",
        won: false,
        lost: true,
        score: 40,
        playedAt: "2026-06-15T00:00:00.000Z",
      });
      // Exactly on the cutoff boundary — INCLUDED (>= is inclusive, E7).
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: true,
        lost: false,
        score: 1,
        playedAt: since,
      });
      // Before the cutoff — EXCLUDED.
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: true,
        lost: false,
        score: 99,
        playedAt: "2026-05-31T23:59:59.999Z",
      });

      const { rows } = await fixture.client.query<{
        game_type: string;
        games_played: string;
        games_won: string;
        games_lost: string;
        total_score: string;
        last_played_at: string;
      }>(`SELECT * FROM get_windowed_stats($1, $2);`, [USER_A, since]);

      const byType = new Map(rows.map((r) => [r.game_type, r]));
      expect(byType.size).toBe(2);

      // big2: 3 rows in window (2 wins incl. boundary, 1 loss), total 5+3+1 = 9.
      const big2 = byType.get("big2")!;
      expect(big2.games_played).toBe("3");
      expect(big2.games_won).toBe("2");
      expect(big2.games_lost).toBe("1");
      expect(big2.total_score).toBe("9");
      // last_played_at is the max within the window (the Jun 20 loss).
      expect(new Date(big2.last_played_at).toISOString()).toBe(
        "2026-06-20T00:00:00.000Z",
      );

      // tonk: 1 loss, score 40.
      const tonk = byType.get("tonk")!;
      expect(tonk.games_played).toBe("1");
      expect(tonk.games_won).toBe("0");
      expect(tonk.games_lost).toBe("1");
      expect(tonk.total_score).toBe("40");
    } finally {
      await fixture.teardown();
    }
  });

  it("returns no rows when the user has no history in the window (E2)", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations(["010_create_game_history.sql"]);

      // A row OUTSIDE the window only.
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: true,
        lost: false,
        score: 5,
        playedAt: "2026-01-01T00:00:00.000Z",
      });

      const { rows } = await fixture.client.query(
        `SELECT * FROM get_windowed_stats($1, $2);`,
        [USER_A, "2026-06-01T00:00:00.000Z"],
      );
      expect(rows).toEqual([]);
    } finally {
      await fixture.teardown();
    }
  });

  it("does not leak another user's rows (filters by user_id)", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations(["010_create_game_history.sql"]);

      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: true,
        lost: false,
        score: 5,
        playedAt: "2026-06-10T00:00:00.000Z",
      });
      await seedHistory(fixture, {
        userId: USER_B,
        gameType: "big2",
        won: false,
        lost: true,
        score: 3,
        playedAt: "2026-06-10T00:00:00.000Z",
      });

      const { rows } = await fixture.client.query<{
        games_played: string;
        total_score: string;
      }>(`SELECT * FROM get_windowed_stats($1, $2);`, [
        USER_A,
        "2026-06-01T00:00:00.000Z",
      ]);

      expect(rows).toHaveLength(1);
      // Only user A's single big2 win — never user B's loss/score.
      expect(rows[0]!.games_played).toBe("1");
      expect(rows[0]!.total_score).toBe("5");
    } finally {
      await fixture.teardown();
    }
  });
});

describe("getTrackingSince (LLD 101 A4)", () => {
  it("returns the earliest played_at across all of a user's history rows", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations(["010_create_game_history.sql"]);

      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: true,
        lost: false,
        score: 5,
        playedAt: "2026-06-10T00:00:00.000Z",
      });
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "tonk",
        won: false,
        lost: true,
        score: 40,
        playedAt: "2026-03-02T08:00:00.000Z",
      });
      await seedHistory(fixture, {
        userId: USER_A,
        gameType: "big2",
        won: false,
        lost: true,
        score: 3,
        playedAt: "2026-06-20T00:00:00.000Z",
      });

      const { rows } = await fixture.client.query<{ earliest: string }>(
        `SELECT min(played_at) AS earliest FROM game_history WHERE user_id = $1;`,
        [USER_A],
      );
      expect(new Date(rows[0]!.earliest).toISOString()).toBe(
        "2026-03-02T08:00:00.000Z",
      );
    } finally {
      await fixture.teardown();
    }
  });

  it("returns null (no row) when the user has no history rows", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations(["010_create_game_history.sql"]);

      const { rows } = await fixture.client.query<{ earliest: string | null }>(
        `SELECT min(played_at) AS earliest FROM game_history WHERE user_id = $1;`,
        [USER_A],
      );
      expect(rows[0]!.earliest).toBeNull();
    } finally {
      await fixture.teardown();
    }
  });
});
