import { Client } from "pg";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { makePgClient } from "./pgClient.js";

/**
 * Prod-shaped migration fixture (LLD 77 §7).
 *
 * Generalizes the one-off throwaway-schema pattern proven by the I4 backfill
 * test and the 006 repair tests in tests/integration/player-stats.test.ts into
 * a reusable fixture that carries prod's known TypeORM-era drift. Any migration
 * test can run the REAL shipped migration SQL against a prod-shaped baseline so
 * a name-coupled migration fails at test time instead of on prod (neutralizes
 * threat vector T1).
 *
 * Isolation: one throwaway schema per fixture instance, created and dropped
 * within the test (testing-principles #3). search_path is set to
 * "<schema>", public so the unqualified table names in migrations resolve into
 * the throwaway schema, exactly as 004/006 already rely on.
 *
 * Credential-free: connects only to the local `supabase start` Postgres via the
 * existing makePgClient defaults (localhost:54322, postgres/postgres). No prod
 * connection, no secret (LLD 77 §9 — this leg is 100% autonomous-safe).
 */

const POSTCONDITIONS_DIR = resolve(
  __dirname,
  "../../../supabase/migrations/postconditions",
);

/** Reads a post-condition SQL file from supabase/migrations/postconditions/. */
export function readPostconditionSql(fileName: string): string {
  return readFileSync(resolve(POSTCONDITIONS_DIR, fileName), "utf8");
}

export interface ProdShapedFixture {
  /** The throwaway schema name created for this fixture instance. */
  readonly schema: string;
  /** Connected pg Client with search_path already set to "<schema>", public. */
  readonly client: Client;
  /** Run real migration SQL (by filename) against this schema, in order. */
  applyMigrations(fileNames: string[]): Promise<void>;
  /** Run a post-condition file (by filename) against this schema; rejects if it RAISEs. */
  runPostcondition(fileName: string): Promise<void>;
  /** Drop the schema and end the client. Always called in finally. */
  teardown(): Promise<void>;
}

export interface ProdShapedOptions {
  /** Which drift artifacts to seed. Defaults to the full known prod-drift set (§7.2). */
  drift?: {
    /** Name PKs *_pkey1 (TypeORM-era) instead of the conventional *_pkey. */
    pkey1ConstraintNames?: boolean;
    /** Grant anon INSERT/UPDATE/DELETE (TypeORM-era residue; 001 grants anon only SELECT). */
    strayAnonWriteGrants?: boolean;
  };
  /** Baseline tables to materialize before applying migrations under test. */
  baseline?: "typeorm-era" | "fresh";
}

/**
 * Reads a migration file's SQL from supabase/migrations/.
 * Local copy (instead of importing readMigrationSql from pgClient) so this
 * helper resolves paths relative to its own __dirname.
 */
function readMigrationSql(fileName: string): string {
  return readFileSync(
    resolve(__dirname, "../../../supabase/migrations", fileName),
    "utf8",
  );
}

/**
 * SQL building blocks for the baseline tables. These mirror the column shape of
 * the as-applied prod schema (the pre-004 player_stats with a single-column PK,
 * plus games/feedback) so the migrations under test exercise a realistic shape.
 * The PK constraint NAME is parameterized to seed the *_pkey1 drift (T1).
 */
function baselineSql(opts: {
  pkey1: boolean;
  strayAnonWrites: boolean;
}): string {
  const playerStatsPkName = opts.pkey1
    ? "player_stats_pkey1"
    : "player_stats_pkey";
  const gamesPkName = opts.pkey1 ? "games_pkey1" : "games_pkey";
  const feedbackPkName = opts.pkey1 ? "feedback_pkey1" : "feedback_pkey";

  // player_stats is materialized in its PRE-004 shape (single-column PK, no
  // game_type) so the 004/006 migrations have something to migrate, exactly
  // like the I4 / 006 tests do.
  const stmts: string[] = [
    `CREATE TABLE games (
       game_id UUID NOT NULL DEFAULT gen_random_uuid(),
       game_type VARCHAR(50) NOT NULL DEFAULT 'big2',
       player_ids UUID[] NOT NULL DEFAULT '{}',
       player_display_names JSONB NOT NULL DEFAULT '{}',
       max_players INT NOT NULL DEFAULT 4,
       status VARCHAR(20) NOT NULL DEFAULT 'CREATED',
       state JSONB NOT NULL DEFAULT '{}',
       turn_timer_seconds INT,
       join_code TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       version INT NOT NULL DEFAULT 1,
       CONSTRAINT ${gamesPkName} PRIMARY KEY (game_id)
     );`,
    `CREATE TABLE player_stats (
       user_id UUID NOT NULL,
       games_played INT NOT NULL DEFAULT 0,
       games_won INT NOT NULL DEFAULT 0,
       games_lost INT NOT NULL DEFAULT 0,
       total_score INT NOT NULL DEFAULT 0,
       last_played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       CONSTRAINT ${playerStatsPkName} PRIMARY KEY (user_id)
     );`,
    `CREATE TABLE feedback (
       id UUID NOT NULL DEFAULT gen_random_uuid(),
       category VARCHAR(20) NOT NULL,
       description VARCHAR(500) NOT NULL,
       metadata JSONB,
       user_id UUID,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       CONSTRAINT ${feedbackPkName} PRIMARY KEY (id)
     );`,
    // The in-tree 001 grants anon only SELECT; this is the baseline grant set.
    `GRANT SELECT ON games, player_stats, feedback TO anon;`,
  ];

  if (opts.strayAnonWrites) {
    // TypeORM-era residue: anon also carries INSERT/UPDATE/DELETE (the surface
    // #83 removes). RLS-neutralized but present on prod.
    stmts.push(
      `GRANT INSERT, UPDATE, DELETE ON games, player_stats, feedback TO anon;`,
    );
  }

  return stmts.join("\n");
}

const DEFAULT_DRIFT = {
  pkey1ConstraintNames: true,
  strayAnonWriteGrants: true,
} as const;

/** Create an isolated prod-shaped schema, seed the requested drift, connect. */
export async function createProdShapedFixture(
  opts: ProdShapedOptions = {},
): Promise<ProdShapedFixture> {
  const baseline = opts.baseline ?? "typeorm-era";
  // The "fresh" baseline carries no drift; the "typeorm-era" baseline defaults
  // to the full known prod-drift set unless the caller toggles individual flags.
  const driftDefaults: {
    pkey1ConstraintNames: boolean;
    strayAnonWriteGrants: boolean;
  } =
    baseline === "fresh"
      ? { pkey1ConstraintNames: false, strayAnonWriteGrants: false }
      : DEFAULT_DRIFT;
  const pkey1 =
    opts.drift?.pkey1ConstraintNames ?? driftDefaults.pkey1ConstraintNames;
  const strayAnonWrites =
    opts.drift?.strayAnonWriteGrants ?? driftDefaults.strayAnonWriteGrants;

  // Unique, isolated schema name. Random suffix avoids collisions between two
  // fixtures created in the same millisecond.
  const schema = `lld77_fixture_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const client = makePgClient();
  await client.connect();

  try {
    await client.query(`CREATE SCHEMA "${schema}";`);
    // search_path is the throwaway schema ONLY (no public). pg_catalog is always
    // implicitly available, so built-in types/functions still resolve, but the
    // migrations' unqualified table AND function references resolve solely into
    // this schema — never colliding with the real public objects of the live
    // `supabase start` DB (e.g. an unqualified REVOKE ON FUNCTION
    // increment_player_stats would otherwise be ambiguous across schemas).
    await client.query(`SET search_path TO "${schema}";`);
    await client.query(baselineSql({ pkey1, strayAnonWrites }));
  } catch (err) {
    // Best-effort cleanup if seeding fails partway.
    try {
      await client.query(`SET search_path TO public;`);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
    } finally {
      await client.end();
    }
    throw err;
  }

  const fixture: ProdShapedFixture = {
    schema,
    client,
    async applyMigrations(fileNames: string[]): Promise<void> {
      for (const fileName of fileNames) {
        await client.query(readMigrationSql(fileName));
      }
    },
    async runPostcondition(fileName: string): Promise<void> {
      await client.query(readPostconditionSql(fileName));
    },
    async teardown(): Promise<void> {
      try {
        await client.query(`SET search_path TO public;`);
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
      } finally {
        await client.end();
      }
    },
  };

  return fixture;
}
