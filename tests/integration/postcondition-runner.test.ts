import { describe, it, expect } from "vitest";
import {
  checkCoverage,
  runPostconditions,
} from "./helpers/postconditionRunner.js";
import {
  createProdShapedFixture,
  readPostconditionSql,
} from "./helpers/prodShapedFixture.js";
import { makePgClient } from "./helpers/pgClient.js";

// ---------------------------------------------------------------------------
// Post-condition verification runner (LLD 77 §6).
//
// The runner asserts 1:1 coverage between migrations and post-condition files,
// then runs each post-condition against a target DB and reports any RAISE.
// These tests prove: coverage detection, release-blocking on a RAISE, and that
// the SAME .sql passes against both a prod-shaped fixture and a clean DB
// (proving name-agnosticism). No prod connection.
// ---------------------------------------------------------------------------

describe("Post-condition coverage (LLD 77 §6.3)", () => {
  it("every shipped migration has a co-located post-condition file (1:1 coverage)", () => {
    const { missing, orphaned } = checkCoverage();
    expect(missing).toEqual([]);
    expect(orphaned).toEqual([]);
  });
});

describe("Post-condition runner — release-blocking on RAISE (LLD 77 §6.1)", () => {
  it("reports a failure when a post-condition RAISEs against an unmigrated schema", async () => {
    // A bare schema with no tables: the 001 post-condition (table presence)
    // must RAISE, so the runner reports a non-empty failures list and ok=false.
    const schema = `lld77_pc_fail_${Date.now().toString(36)}`;
    const pg = makePgClient();
    await pg.connect();
    try {
      await pg.query(`CREATE SCHEMA "${schema}";`);
      // search_path is the throwaway schema ONLY (no public fallback) so the
      // post-conditions resolve nothing — proving they RAISE against a target
      // that has not been migrated, rather than silently resolving the real
      // public tables/functions of the live `supabase start` DB.
      await pg.query(`SET search_path TO "${schema}";`);

      const result = await runPostconditions(pg);

      expect(result.ok).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
      // The 001 post-condition (table presence) is among the failures.
      expect(result.failures.some((f) => f.key.startsWith("001"))).toBe(true);
    } finally {
      await pg.query(`SET search_path TO public;`);
      await pg.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
      await pg.end();
    }
  });
});

describe("Post-condition runner — passes against migrated targets (LLD 77 §6.3)", () => {
  // Prod-shaped with the *_pkey1 constraint drift (which 006 repairs). The
  // stray anon write grants are NOT seeded here: no in-tree migration revokes
  // them (that is #83's job), so they would correctly keep 001's SELECT-only
  // post-condition failing — that case is covered by the drift-toggle test in
  // prod-shaped-fixture.test.ts. This test proves the migrations + 006 together
  // satisfy every post-condition on a prod-shaped (name-drifted) baseline.
  it("all post-conditions pass against a name-drifted prod-shaped fixture migrated 001..010", async () => {
    const fixture = await createProdShapedFixture({
      baseline: "typeorm-era",
      drift: { pkey1ConstraintNames: true, strayAnonWriteGrants: false },
    });
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
      ]);

      const result = await runPostconditions(fixture.client);
      expect(result.failures).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      await fixture.teardown();
    }
  });

  it("all post-conditions pass against a fresh baseline migrated 001..010 (same .sql, two contexts)", async () => {
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
      ]);

      const result = await runPostconditions(fixture.client);
      expect(result.failures).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      await fixture.teardown();
    }
  });

  it("a single post-condition file is readable and runnable in isolation", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "001_create_tables.sql",
        "002_enable_rls.sql",
        "003_increment_stats_rpc.sql",
        "004_player_stats_game_type.sql",
        "005_increment_stats_rpc_game_type.sql",
        "006_fix_player_stats_composite_pk.sql",
      ]);

      // readPostconditionSql + runPostcondition both resolve the same file.
      expect(
        readPostconditionSql("004_player_stats_game_type.postcondition.sql"),
      ).toContain("POSTCONDITION FAILED (004");
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
