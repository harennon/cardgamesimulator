import { describe, it, expect } from "vitest";
import { createProdShapedFixture } from "./helpers/prodShapedFixture.js";

// ---------------------------------------------------------------------------
// Prod-shaped fixture (LLD 77 §7).
//
// Generalizes the throwaway-schema pattern (I4 / 006 tests) into a reusable
// fixture carrying prod's known TypeORM-era drift. These tests prove the
// headline regression-of-incident behaviour, isolation, drift toggles, and that
// the fixture runs the REAL migration SQL. Credential-free: local Supabase only.
// ---------------------------------------------------------------------------

async function pkColumns(
  fixture: Awaited<ReturnType<typeof createProdShapedFixture>>,
): Promise<string[]> {
  const { rows } = await fixture.client.query<{ cols: string[] | null }>(
    `SELECT array_agg(att.attname::text ORDER BY att.attname::text) AS cols
     FROM pg_constraint c
     JOIN unnest(c.conkey) AS k ON true
     JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = k
     WHERE c.conrelid = to_regclass('player_stats') AND c.contype = 'p';`,
  );
  return rows[0]?.cols ?? [];
}

describe("Prod-shaped fixture — regression of the LLD 66 incident (§7.4)", () => {
  it("004 alone against pkey1 drift leaves a single-column PK and the PK post-condition RAISEs", async () => {
    const fixture = await createProdShapedFixture({
      drift: { pkey1ConstraintNames: true },
    });
    try {
      // 004's hardcoded DROP CONSTRAINT IF EXISTS player_stats_pkey matches
      // nothing against the *_pkey1-named PK, so the composite PK is never
      // applied — exactly the prod failure.
      await fixture.applyMigrations(["004_player_stats_game_type.sql"]);

      // The PK is still the single-column (user_id) — the incident.
      expect(await pkColumns(fixture)).toEqual(["user_id"]);

      // The §6.2 PK post-condition therefore RAISEs (release would be blocked).
      await expect(
        fixture.runPostcondition(
          "004_player_stats_game_type.postcondition.sql",
        ),
      ).rejects.toThrow(/POSTCONDITION FAILED \(004/);
    } finally {
      await fixture.teardown();
    }
  });

  it("004 + 006 against pkey1 drift repairs the composite PK and the post-condition passes", async () => {
    const fixture = await createProdShapedFixture({
      drift: { pkey1ConstraintNames: true },
    });
    try {
      await fixture.applyMigrations([
        "004_player_stats_game_type.sql",
        "006_fix_player_stats_composite_pk.sql",
      ]);

      // 006 repairs by the ACTUAL constraint name → composite PK applied.
      expect(await pkColumns(fixture)).toEqual(["game_type", "user_id"]);
      await expect(
        fixture.runPostcondition(
          "006_fix_player_stats_composite_pk.postcondition.sql",
        ),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.teardown();
    }
  });

  it("004 alone against a fresh baseline (no drift) applies the composite PK and passes", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations(["004_player_stats_game_type.sql"]);
      // On a fresh DB the PK was the conventional player_stats_pkey, so 004's
      // hardcoded drop matches and the composite PK is applied.
      expect(await pkColumns(fixture)).toEqual(["game_type", "user_id"]);
      await expect(
        fixture.runPostcondition(
          "004_player_stats_game_type.postcondition.sql",
        ),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.teardown();
    }
  });
});

describe("Prod-shaped fixture — drift toggles (§7.2/§7.3)", () => {
  it("strayAnonWriteGrants seeds anon INSERT/UPDATE/DELETE; the 001 grant post-condition fails", async () => {
    const fixture = await createProdShapedFixture({
      baseline: "typeorm-era",
      drift: { strayAnonWriteGrants: true },
    });
    try {
      await fixture.applyMigrations(["001_create_tables.sql"]);

      // anon carries the stray write grants the fixture seeded.
      const { rows } = await fixture.client.query<{ can: boolean }>(
        `SELECT has_table_privilege('anon', to_regclass('player_stats'), 'INSERT') AS can;`,
      );
      expect(rows[0]?.can).toBe(true);

      // The 001 post-condition asserts anon SELECT-only → must RAISE here.
      await expect(
        fixture.runPostcondition("001_create_tables.postcondition.sql"),
      ).rejects.toThrow(/POSTCONDITION FAILED \(001/);
    } finally {
      await fixture.teardown();
    }
  });

  it("a fresh baseline carries no stray anon write grants; the 001 grant post-condition passes", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations(["001_create_tables.sql"]);

      const { rows } = await fixture.client.query<{ can: boolean }>(
        `SELECT has_table_privilege('anon', to_regclass('player_stats'), 'INSERT') AS can;`,
      );
      expect(rows[0]?.can).toBe(false);

      await expect(
        fixture.runPostcondition("001_create_tables.postcondition.sql"),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.teardown();
    }
  });
});

describe("Prod-shaped fixture — isolation (§7.3)", () => {
  it("two fixtures get distinct schemas and do not collide", async () => {
    const a = await createProdShapedFixture({ baseline: "fresh" });
    const b = await createProdShapedFixture({ baseline: "fresh" });
    try {
      expect(a.schema).not.toBe(b.schema);

      // A change in a's schema is invisible to b's schema. The pre-004
      // player_stats has only user_id (+ counters), so insert by user_id alone.
      await a.client.query(
        `INSERT INTO player_stats (user_id) VALUES (gen_random_uuid());`,
      );
      // b's player_stats (a different schema) is unaffected → still 0 rows.
      const { rows } = await b.client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM player_stats;`,
      );
      expect(rows[0]?.n).toBe("0");
    } finally {
      await a.teardown();
      await b.teardown();
    }
  });

  it("teardown drops the schema (the schema no longer exists afterward)", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    const schema = fixture.schema;
    await fixture.teardown();

    // Verify via a fresh connection that the schema is gone.
    const probe = (await import("./helpers/pgClient.js")).makePgClient();
    await probe.connect();
    try {
      const { rows } = await probe.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.schemata WHERE schema_name = $1;`,
        [schema],
      );
      expect(rows[0]?.n).toBe("0");
    } finally {
      await probe.end();
    }
  });
});
