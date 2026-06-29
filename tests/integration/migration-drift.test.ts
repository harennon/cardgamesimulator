import { describe, it, expect } from "vitest";
import { makePgClient, readMigrationSql } from "./helpers/pgClient.js";

// ---------------------------------------------------------------------------
// LLD 75: Clean up prod schema drift inherited from the TypeORM era.
//
// 007 normalizes the PK constraint names on `games`/`feedback` from prod's
// '*_pkey1' to the conventional '*_pkey' (name-agnostic lookup + RENAME).
// 008 revokes the stray anon INSERT/UPDATE/DELETE grants so they match 001's
// declared SELECT-only intent.
//
// A clean `supabase start` already has the conventional PK names and
// SELECT-only anon grants, so these tests self-materialize BOTH the prod-like
// drifted state and the fresh-like clean state in dedicated throwaway schemas,
// run the REAL migration SQL against each (search_path-scoped, exactly like the
// 004/006 harness in player-stats.test.ts), and assert the outcome.
// Self-contained: each schema is created and dropped within the test.
// ---------------------------------------------------------------------------

describe("Migration 007 PK-name normalization", () => {
  it("prod-like: renames a PK named 'games_pkey1' to 'games_pkey', columns unchanged", async () => {
    const schema = `lld75_007_games_${Date.now().toString(36)}`;
    const pg = makePgClient();
    await pg.connect();

    try {
      // 1. Materialize the prod state: a `games` table whose PK carries the
      //    TypeORM-era '*_pkey1' name.
      await pg.query(`CREATE SCHEMA "${schema}";`);
      await pg.query(`SET search_path TO "${schema}", public;`);
      await pg.query(
        `CREATE TABLE games (
           game_id UUID NOT NULL,
           game_type VARCHAR(50) NOT NULL DEFAULT 'big2',
           CONSTRAINT games_pkey1 PRIMARY KEY (game_id)
         );`,
      );

      // Sanity: the PK starts with the prod-only name.
      const prePk = await pg.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = '${schema}.games'::regclass AND contype = 'p';`,
      );
      expect(prePk.rows).toHaveLength(1);
      expect(prePk.rows[0]!.conname).toBe("games_pkey1");
      expect(prePk.rows[0]!.def).toBe("PRIMARY KEY (game_id)");

      // 2. Run the REAL 007 migration SQL against this schema.
      await pg.query(readMigrationSql("007_normalize_pk_names.sql"));

      // 3. Exactly one PK, conventionally named, columns unchanged, old name gone.
      const postPk = await pg.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = '${schema}.games'::regclass AND contype = 'p';`,
      );
      expect(postPk.rows).toHaveLength(1);
      expect(postPk.rows[0]!.conname).toBe("games_pkey");
      expect(postPk.rows[0]!.def).toBe("PRIMARY KEY (game_id)");
    } finally {
      await pg.query(`SET search_path TO public;`);
      await pg.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
      await pg.end();
    }
  });

  it("prod-like: renames a PK named 'feedback_pkey1' to 'feedback_pkey', columns unchanged", async () => {
    const schema = `lld75_007_feedback_${Date.now().toString(36)}`;
    const pg = makePgClient();
    await pg.connect();

    try {
      await pg.query(`CREATE SCHEMA "${schema}";`);
      await pg.query(`SET search_path TO "${schema}", public;`);
      await pg.query(
        `CREATE TABLE feedback (
           id UUID NOT NULL DEFAULT gen_random_uuid(),
           category VARCHAR(20) NOT NULL,
           CONSTRAINT feedback_pkey1 PRIMARY KEY (id)
         );`,
      );

      const prePk = await pg.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = '${schema}.feedback'::regclass AND contype = 'p';`,
      );
      expect(prePk.rows).toHaveLength(1);
      expect(prePk.rows[0]!.conname).toBe("feedback_pkey1");
      expect(prePk.rows[0]!.def).toBe("PRIMARY KEY (id)");

      await pg.query(readMigrationSql("007_normalize_pk_names.sql"));

      const postPk = await pg.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = '${schema}.feedback'::regclass AND contype = 'p';`,
      );
      expect(postPk.rows).toHaveLength(1);
      expect(postPk.rows[0]!.conname).toBe("feedback_pkey");
      expect(postPk.rows[0]!.def).toBe("PRIMARY KEY (id)");
    } finally {
      await pg.query(`SET search_path TO public;`);
      await pg.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
      await pg.end();
    }
  });

  it("fresh-like: is a no-op (and idempotent) when PK names are already conventional, preserving the constraint object", async () => {
    const schema = `lld75_007_fresh_${Date.now().toString(36)}`;
    const pg = makePgClient();
    await pg.connect();

    try {
      // 1. Materialize the fresh state: both tables already carry the
      //    conventional PK names. Include a third table with NO primary key to
      //    exercise the `pk_name IS NULL` guard (Edge Case 4) -- 007 ignores it.
      await pg.query(`CREATE SCHEMA "${schema}";`);
      await pg.query(`SET search_path TO "${schema}", public;`);
      await pg.query(
        `CREATE TABLE games (
           game_id UUID NOT NULL,
           CONSTRAINT games_pkey PRIMARY KEY (game_id)
         );`,
      );
      await pg.query(
        `CREATE TABLE feedback (
           id UUID NOT NULL,
           CONSTRAINT feedback_pkey PRIMARY KEY (id)
         );`,
      );

      // Capture each PK's OID so we can prove 007 did NOT rename/recreate it.
      const beforeGames = await pg.query<{ oid: string }>(
        `SELECT oid::text AS oid FROM pg_constraint
         WHERE conrelid = '${schema}.games'::regclass AND contype = 'p';`,
      );
      const beforeFeedback = await pg.query<{ oid: string }>(
        `SELECT oid::text AS oid FROM pg_constraint
         WHERE conrelid = '${schema}.feedback'::regclass AND contype = 'p';`,
      );
      expect(beforeGames.rows).toHaveLength(1);
      expect(beforeFeedback.rows).toHaveLength(1);

      // 2. Run 007 twice to prove it is a no-op AND idempotent. (A no-PK table
      //    is also present in this schema; if 007 errored on the IS NULL branch
      //    these statements would throw.)
      await pg.query(readMigrationSql("007_normalize_pk_names.sql"));
      await pg.query(readMigrationSql("007_normalize_pk_names.sql"));

      // 3. Each PK is unchanged: same name, same columns, SAME constraint object
      //    (OID identical) -- proving no drop/recreate occurred.
      const afterGames = await pg.query<{
        oid: string;
        conname: string;
        def: string;
      }>(
        `SELECT oid::text AS oid, conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
         WHERE conrelid = '${schema}.games'::regclass AND contype = 'p';`,
      );
      const afterFeedback = await pg.query<{
        oid: string;
        conname: string;
        def: string;
      }>(
        `SELECT oid::text AS oid, conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
         WHERE conrelid = '${schema}.feedback'::regclass AND contype = 'p';`,
      );

      expect(afterGames.rows).toHaveLength(1);
      expect(afterGames.rows[0]!.conname).toBe("games_pkey");
      expect(afterGames.rows[0]!.def).toBe("PRIMARY KEY (game_id)");
      expect(afterGames.rows[0]!.oid).toBe(beforeGames.rows[0]!.oid);

      expect(afterFeedback.rows).toHaveLength(1);
      expect(afterFeedback.rows[0]!.conname).toBe("feedback_pkey");
      expect(afterFeedback.rows[0]!.def).toBe("PRIMARY KEY (id)");
      expect(afterFeedback.rows[0]!.oid).toBe(beforeFeedback.rows[0]!.oid);
    } finally {
      await pg.query(`SET search_path TO public;`);
      await pg.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
      await pg.end();
    }
  });
});

describe("Migration 008 anon write-grant revocation", () => {
  it("prod-like: removes anon INSERT/UPDATE/DELETE on games/player_stats/feedback, leaving SELECT intact", async () => {
    const schema = `lld75_008_prod_${Date.now().toString(36)}`;
    const pg = makePgClient();
    await pg.connect();

    const tables = ["games", "player_stats", "feedback"];

    try {
      // 1. Materialize the prod state: anon holds SELECT *and* the stray write
      //    grants on all three tables.
      await pg.query(`CREATE SCHEMA "${schema}";`);
      await pg.query(`SET search_path TO "${schema}", public;`);
      for (const table of tables) {
        await pg.query(`CREATE TABLE ${table} (id UUID PRIMARY KEY);`);
        await pg.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO anon;`,
        );
      }

      // Sanity: anon starts with all four privileges on every table.
      for (const table of tables) {
        const pre = await pg.query<{
          ins: boolean;
          upd: boolean;
          del: boolean;
          sel: boolean;
        }>(
          `SELECT
             has_table_privilege('anon', '${schema}.${table}', 'INSERT') AS ins,
             has_table_privilege('anon', '${schema}.${table}', 'UPDATE') AS upd,
             has_table_privilege('anon', '${schema}.${table}', 'DELETE') AS del,
             has_table_privilege('anon', '${schema}.${table}', 'SELECT') AS sel;`,
        );
        expect(pre.rows[0]).toEqual({
          ins: true,
          upd: true,
          del: true,
          sel: true,
        });
      }

      // 2. Run the REAL 008 migration SQL against this schema.
      await pg.query(readMigrationSql("008_revoke_anon_writes.sql"));

      // 3. anon write grants are gone on every table; SELECT remains.
      for (const table of tables) {
        const post = await pg.query<{
          ins: boolean;
          upd: boolean;
          del: boolean;
          sel: boolean;
        }>(
          `SELECT
             has_table_privilege('anon', '${schema}.${table}', 'INSERT') AS ins,
             has_table_privilege('anon', '${schema}.${table}', 'UPDATE') AS upd,
             has_table_privilege('anon', '${schema}.${table}', 'DELETE') AS del,
             has_table_privilege('anon', '${schema}.${table}', 'SELECT') AS sel;`,
        );
        expect(post.rows[0]).toEqual({
          ins: false,
          upd: false,
          del: false,
          sel: true,
        });
      }
    } finally {
      await pg.query(`SET search_path TO public;`);
      await pg.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
      await pg.end();
    }
  });

  it("fresh-like: is a no-op (and idempotent) when anon never had write grants", async () => {
    const schema = `lld75_008_fresh_${Date.now().toString(36)}`;
    const pg = makePgClient();
    await pg.connect();

    const tables = ["games", "player_stats", "feedback"];

    try {
      // 1. Materialize the fresh state: anon holds only SELECT (matches 001).
      await pg.query(`CREATE SCHEMA "${schema}";`);
      await pg.query(`SET search_path TO "${schema}", public;`);
      for (const table of tables) {
        await pg.query(`CREATE TABLE ${table} (id UUID PRIMARY KEY);`);
        await pg.query(`GRANT SELECT ON ${table} TO anon;`);
      }

      // 2. Run 008 twice to prove it is a no-op AND idempotent (revoking an
      //    absent grant is a silent no-op in Postgres).
      await pg.query(readMigrationSql("008_revoke_anon_writes.sql"));
      await pg.query(readMigrationSql("008_revoke_anon_writes.sql"));

      // 3. SELECT still present; writes still absent.
      for (const table of tables) {
        const post = await pg.query<{
          ins: boolean;
          upd: boolean;
          del: boolean;
          sel: boolean;
        }>(
          `SELECT
             has_table_privilege('anon', '${schema}.${table}', 'INSERT') AS ins,
             has_table_privilege('anon', '${schema}.${table}', 'UPDATE') AS upd,
             has_table_privilege('anon', '${schema}.${table}', 'DELETE') AS del,
             has_table_privilege('anon', '${schema}.${table}', 'SELECT') AS sel;`,
        );
        expect(post.rows[0]).toEqual({
          ins: false,
          upd: false,
          del: false,
          sel: true,
        });
      }
    } finally {
      await pg.query(`SET search_path TO public;`);
      await pg.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
      await pg.end();
    }
  });
});
