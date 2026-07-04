import { describe, it, expect } from "vitest";
import { createProdShapedFixture } from "./helpers/prodShapedFixture.js";

// ---------------------------------------------------------------------------
// LLD 011: migration 011 locks down game_history — REVOKE the stray TypeORM-era
// anon/authenticated write grants + ENABLE RLS + a SELECT-own-rows policy.
// Self-materializes a prod-shaped baseline in a throwaway schema, applies the
// REAL 010 then 011 SQL, and asserts the locked-down end state directly via
// catalog/privilege queries (name-agnostic; testing-principles §3). The
// prodShapedFixture strayAnonWriteGrants flag seeds grants on
// games/player_stats/feedback (baselineSql), NOT on game_history (created by
// 010 inside the test) — so the prod-like test explicitly re-grants on
// game_history to reproduce the prod drift, then applies 011 and asserts.
// Credential-free: local supabase start only, no prod connection (LLD 77 §9).
// ---------------------------------------------------------------------------

type Fixture = Awaited<ReturnType<typeof createProdShapedFixture>>;

/** Reproduce the prod drift: TypeORM-era stray write grants on game_history. */
async function seedStrayGameHistoryGrants(fixture: Fixture): Promise<void> {
  await fixture.client.query(
    `GRANT INSERT, UPDATE, DELETE ON game_history TO anon, authenticated;`,
  );
}

/** Read the effective table privileges for a role on game_history. */
async function privs(
  fixture: Fixture,
  role: string,
): Promise<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }> {
  const { rows } = await fixture.client.query<{
    sel: boolean;
    ins: boolean;
    upd: boolean;
    del: boolean;
  }>(
    `SELECT has_table_privilege($1, to_regclass('game_history'), 'SELECT') AS sel,
            has_table_privilege($1, to_regclass('game_history'), 'INSERT') AS ins,
            has_table_privilege($1, to_regclass('game_history'), 'UPDATE') AS upd,
            has_table_privilege($1, to_regclass('game_history'), 'DELETE') AS del;`,
    [role],
  );
  return rows[0]!;
}

describe("Migration 011 game_history lockdown (LLD 011)", () => {
  it("prod-like: revokes the stray anon/authenticated write grants; SELECT + service_role intact", async () => {
    // typeorm-era baseline carries the drift on the OTHER tables; game_history is
    // created by 010 here, so we re-grant the stray writes on it explicitly.
    const fixture = await createProdShapedFixture({ baseline: "typeorm-era" });
    try {
      await fixture.applyMigrations(["010_create_game_history.sql"]);
      await seedStrayGameHistoryGrants(fixture);

      // Sanity: the drift is present before 011.
      const anonBefore = await privs(fixture, "anon");
      expect(anonBefore).toMatchObject({ ins: true, upd: true, del: true });

      await fixture.applyMigrations(["011_lock_down_game_history.sql"]);

      // anon + authenticated: SELECT only, no write DML after 011.
      for (const role of ["anon", "authenticated"]) {
        expect(await privs(fixture, role)).toMatchObject({
          sel: true,
          ins: false,
          upd: false,
          del: false,
        });
      }
      // service_role: full access retained.
      expect(await privs(fixture, "service_role")).toMatchObject({
        sel: true,
        ins: true,
        upd: true,
        del: true,
      });
    } finally {
      await fixture.teardown();
    }
  });

  it("enables RLS and creates exactly a SELECT-own-rows policy (no write policies)", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "010_create_game_history.sql",
        "011_lock_down_game_history.sql",
      ]);

      const { rows: rlsRows } = await fixture.client.query<{ on: boolean }>(
        `SELECT relrowsecurity AS on FROM pg_class WHERE oid = to_regclass('game_history');`,
      );
      expect(rlsRows[0]!.on).toBe(true);

      const { rows: polRows } = await fixture.client.query<{
        cmd: string;
        qual: string | null;
      }>(
        `SELECT cmd, qual FROM pg_policies
         WHERE schemaname = current_schema() AND tablename = 'game_history';`,
      );
      // Exactly one policy, a SELECT-command policy whose qual references user_id.
      expect(polRows).toHaveLength(1);
      expect(polRows[0]!.cmd).toBe("SELECT");
      expect(polRows[0]!.qual).toMatch(/user_id/);
      // No INSERT/UPDATE/DELETE policy.
      const writePolicies = polRows.filter((p) =>
        ["INSERT", "UPDATE", "DELETE", "ALL"].includes(p.cmd),
      );
      expect(writePolicies).toHaveLength(0);
    } finally {
      await fixture.teardown();
    }
  });

  it("fresh-like: REVOKE is a no-op and 011 is idempotent (applying twice → exactly one SELECT policy)", async () => {
    // Fresh baseline never had the stray grants; 010 then 011 applied TWICE.
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations(["010_create_game_history.sql"]);
      await fixture.applyMigrations(["011_lock_down_game_history.sql"]);
      await fixture.applyMigrations(["011_lock_down_game_history.sql"]);

      // SELECT still true, write privs still false for anon/authenticated.
      for (const role of ["anon", "authenticated"]) {
        expect(await privs(fixture, role)).toMatchObject({
          sel: true,
          ins: false,
          upd: false,
          del: false,
        });
      }

      // RLS on, and the current_schema() guard prevented a duplicate CREATE.
      const { rows: rlsRows } = await fixture.client.query<{ on: boolean }>(
        `SELECT relrowsecurity AS on FROM pg_class WHERE oid = to_regclass('game_history');`,
      );
      expect(rlsRows[0]!.on).toBe(true);

      const { rows: countRows } = await fixture.client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_policies
         WHERE schemaname = current_schema() AND tablename = 'game_history' AND cmd = 'SELECT';`,
      );
      expect(countRows[0]!.n).toBe("1");
    } finally {
      await fixture.teardown();
    }
  });

  it("the 011 post-condition passes on the locked-down schema and RAISEs when RLS is absent", async () => {
    const lockedDown = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await lockedDown.applyMigrations([
        "010_create_game_history.sql",
        "011_lock_down_game_history.sql",
      ]);
      await expect(
        lockedDown.runPostcondition(
          "011_lock_down_game_history.postcondition.sql",
        ),
      ).resolves.toBeUndefined();
    } finally {
      await lockedDown.teardown();
    }

    // 010 only (no 011) → RLS absent → the 011 post-condition RAISEs (has teeth).
    const noRls = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await noRls.applyMigrations(["010_create_game_history.sql"]);
      await expect(
        noRls.runPostcondition("011_lock_down_game_history.postcondition.sql"),
      ).rejects.toThrow(/POSTCONDITION FAILED \(011/);
    } finally {
      await noRls.teardown();
    }
  });

  it("the hardened 010 post-condition passes after 011 and RAISEs when 011 is absent (backfill closes the regression window)", async () => {
    const lockedDown = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await lockedDown.applyMigrations([
        "010_create_game_history.sql",
        "011_lock_down_game_history.sql",
      ]);
      await expect(
        lockedDown.runPostcondition(
          "010_create_game_history.postcondition.sql",
        ),
      ).resolves.toBeUndefined();
    } finally {
      await lockedDown.teardown();
    }

    // 010 only: the hardened 010 post-condition now asserts RLS, which 010 alone
    // does not enable → it RAISEs, proving the backfill closes the gap.
    const noRls = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await noRls.applyMigrations(["010_create_game_history.sql"]);
      await expect(
        noRls.runPostcondition("010_create_game_history.postcondition.sql"),
      ).rejects.toThrow(/POSTCONDITION FAILED \(010/);
    } finally {
      await noRls.teardown();
    }
  });
});
