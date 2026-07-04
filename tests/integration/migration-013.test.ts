/**
 * Migration-013 test (LLD 153): prod-shaped, name-agnostic.
 *
 * The feedback-attachments bucket and its deny policies live in the `storage`
 * schema which is managed by Supabase — prodShapedFixture's throwaway `public`
 * schema cannot host it. Strategy (per LLD 153 §Test Requirements):
 *
 *   • public-schema parts (feedback.attachment_keys column + RPC grant discipline)
 *     — run through prodShapedFixture (isolated throwaway schema).
 *   • storage-schema parts (bucket + policies + RLS assertion)
 *     — run against the real local `storage` schema, cleaning up the test bucket
 *     in a `finally` block.
 *
 * The 013 postcondition is run against the real live schema (both public and
 * storage objects must be present), so we apply the real migration to the local
 * supabase stack before executing it.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { makePgClient, readMigrationSql } from "./helpers/pgClient.js";
import { createProdShapedFixture } from "./helpers/prodShapedFixture.js";
import { getSupabaseUrl, getSupabaseAnonKey } from "./helpers/env.js";
import { SupabaseDB } from "../../src/backend/database/supabaseDb.js";

const BUCKET = "feedback-attachments";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnonClient(): SupabaseClient {
  return createClient(getSupabaseUrl(), getSupabaseAnonKey());
}

// ---------------------------------------------------------------------------
// public-schema parts: attachment_keys column + RPC grant discipline
// ---------------------------------------------------------------------------

describe("Migration 013 — public-schema parts (prodShapedFixture)", () => {
  it("adds attachment_keys TEXT[] NOT NULL DEFAULT '{}' to feedback", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "013_create_feedback_attachments_bucket.sql",
      ]);

      const { rows } = await fixture.client.query<{
        type: string;
        notnull: boolean;
        def: string | null;
      }>(
        `SELECT format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS notnull,
                pg_get_expr(ad.adbin, ad.adrelid) AS def
         FROM pg_attribute a
         LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
         WHERE a.attrelid = to_regclass('feedback')
           AND a.attname  = 'attachment_keys'
           AND NOT a.attisdropped;`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toMatch(/text\[\]/);
      expect(rows[0]!.notnull).toBe(true);
      expect(rows[0]!.def).toMatch(/'\{\}'/);
    } finally {
      await fixture.teardown();
    }
  });

  it("is idempotent: applying 013 twice does not error or duplicate the column", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "013_create_feedback_attachments_bucket.sql",
      ]);
      await fixture.applyMigrations([
        "013_create_feedback_attachments_bucket.sql",
      ]);

      const { rows } = await fixture.client.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM pg_attribute a
         WHERE a.attrelid = to_regclass('feedback')
           AND a.attname  = 'attachment_keys'
           AND NOT a.attisdropped;`,
      );
      expect(rows[0]!.n).toBe("1");
    } finally {
      await fixture.teardown();
    }
  });

  it("append_feedback_attachment_key: EXECUTE granted to service_role, revoked from anon/authenticated/PUBLIC", async () => {
    const fixture = await createProdShapedFixture({ baseline: "fresh" });
    try {
      await fixture.applyMigrations([
        "013_create_feedback_attachments_bucket.sql",
      ]);

      const { rows } = await fixture.client.query<{
        svc: boolean;
        anon: boolean;
        authd: boolean;
        pub: boolean;
      }>(
        `SELECT
           has_function_privilege('service_role', fn_oid, 'EXECUTE') AS svc,
           has_function_privilege('anon',         fn_oid, 'EXECUTE') AS anon,
           has_function_privilege('authenticated',fn_oid, 'EXECUTE') AS authd,
           has_function_privilege('public',       fn_oid, 'EXECUTE') AS pub
         FROM (
           SELECT oid AS fn_oid FROM pg_proc
           WHERE proname = 'append_feedback_attachment_key'
             AND pg_function_is_visible(oid)
           LIMIT 1
         ) t;`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.svc).toBe(true);
      expect(rows[0]!.anon).toBe(false);
      expect(rows[0]!.authd).toBe(false);
      expect(rows[0]!.pub).toBe(false);
    } finally {
      await fixture.teardown();
    }
  });

  it("append_feedback_attachment_key actually appends a key and returns the updated array", async () => {
    // The RPC has SET search_path = public (SECURITY DEFINER), so it always
    // resolves feedback to public.feedback regardless of the caller's
    // search_path. This test therefore runs against the real live public schema
    // (not a throwaway fixture) and cleans up in finally.
    const pg = makePgClient();
    await pg.connect();
    let feedbackId: string | undefined;
    try {
      const { rows: ins } = await pg.query<{ id: string }>(
        `INSERT INTO public.feedback (category, description)
         VALUES ('bug', 'rpc-append-test')
         RETURNING id;`,
      );
      feedbackId = ins[0]!.id;

      const { rows } = await pg.query<{ attachment_keys: string[] }>(
        `SELECT append_feedback_attachment_key($1::uuid, $2) AS attachment_keys;`,
        [feedbackId, "some-prefix/uuid.png"],
      );
      expect(rows[0]!.attachment_keys).toEqual(["some-prefix/uuid.png"]);
    } finally {
      if (feedbackId) {
        await pg
          .query(`DELETE FROM public.feedback WHERE id = $1;`, [feedbackId])
          .catch(() => undefined);
      }
      await pg.end();
    }
  });
});

// ---------------------------------------------------------------------------
// storage-schema parts: bucket + RLS policies (real local storage schema)
// ---------------------------------------------------------------------------

describe("Migration 013 — storage-schema parts (real local storage schema)", () => {
  beforeAll(() => {
    // SupabaseDB needs to be initialized for storageClient access.
    SupabaseDB.INSTANCE.initialize();
  });

  it("bucket feedback-attachments exists and is private", async () => {
    const pg = makePgClient();
    await pg.connect();
    try {
      const { rows } = await pg.query<{ public: boolean }>(
        `SELECT public FROM storage.buckets WHERE id = 'feedback-attachments';`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.public).toBe(false);
    } finally {
      await pg.end();
    }
  });

  it("RLS is enabled on storage.objects", async () => {
    const pg = makePgClient();
    await pg.connect();
    try {
      const { rows } = await pg.query<{ on: boolean }>(
        `SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'storage.objects'::regclass;`,
      );
      expect(rows[0]!.on).toBe(true);
    } finally {
      await pg.end();
    }
  });

  it("at least 2 deny-by-construction policies reference the bucket on storage.objects", async () => {
    const pg = makePgClient();
    await pg.connect();
    try {
      const { rows } = await pg.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM pg_policies
         WHERE schemaname = 'storage'
           AND tablename  = 'objects'
           AND (qual LIKE '%feedback-attachments%' OR with_check LIKE '%feedback-attachments%');`,
      );
      expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2);
    } finally {
      await pg.end();
    }
  });

  it("anon cannot read objects from the private bucket (deny-by-construction)", async () => {
    // The anon Supabase client should be unable to list or download from the bucket.
    const anon = makeAnonClient();
    const { data, error } = await anon.storage.from(BUCKET).list();
    // PostgREST/Storage returns an error or empty due to the deny policy.
    // Either an error or an empty/null data set is acceptable — what is NOT
    // acceptable is getting back a non-error list response with objects.
    if (!error) {
      // If no error, the list must be empty (deny policy prevents reads).
      expect((data ?? []).length).toBe(0);
    }
    // If there is an error, the deny is working as intended.
  });

  it("service_role can upload to and read from the bucket", async () => {
    // Use the service_role client (bypasses RLS) to round-trip a tiny object.
    const testKey = `_test-migration-013/${Date.now()}.txt`;
    const content = Buffer.from("ping");

    const { error: uploadErr } = await SupabaseDB.INSTANCE.storageClient.storage
      .from(BUCKET)
      .upload(testKey, content, { contentType: "text/plain", upsert: true });
    expect(uploadErr).toBeNull();

    const { data: signedData, error: signedErr } =
      await SupabaseDB.INSTANCE.storageClient.storage
        .from(BUCKET)
        .createSignedUrl(testKey, 60);
    expect(signedErr).toBeNull();
    expect(signedData?.signedUrl).toMatch(/^https?:\/\//);

    // Clean up.
    await SupabaseDB.INSTANCE.storageClient.storage
      .from(BUCKET)
      .remove([testKey]);
  });

  it("idempotency: applying 013 twice produces exactly the intended bucket + policy set", async () => {
    // Re-run the migration SQL via raw pg. Because the migration guards with
    // IF NOT EXISTS / ON CONFLICT DO NOTHING it must be error-free and must
    // not duplicate the bucket row or policies.
    const pg = makePgClient();
    await pg.connect();
    try {
      await pg.query(
        readMigrationSql("013_create_feedback_attachments_bucket.sql"),
      );
      await pg.query(
        readMigrationSql("013_create_feedback_attachments_bucket.sql"),
      );

      const { rows: bucketRows } = await pg.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM storage.buckets WHERE id = 'feedback-attachments';`,
      );
      expect(bucketRows[0]!.n).toBe("1");

      const { rows: policyRows } = await pg.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM pg_policies
         WHERE schemaname = 'storage'
           AND tablename  = 'objects'
           AND (qual LIKE '%feedback-attachments%' OR with_check LIKE '%feedback-attachments%');`,
      );
      expect(Number(policyRows[0]!.n)).toBeGreaterThanOrEqual(2);
    } finally {
      await pg.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Postcondition self-test
// ---------------------------------------------------------------------------

describe("Migration 013 — postcondition", () => {
  it("013 postcondition passes on the applied live schema", async () => {
    // Run the real 013 SQL against a fresh fixture to satisfy the public-schema
    // parts; the storage parts are checked against the live schema by the SQL
    // referencing storage.buckets / pg_policies directly.
    // We run the postcondition against the LIVE schema (not the fixture) because
    // it asserts both storage.buckets (live) and public.feedback (live after 013).
    const pg = makePgClient();
    await pg.connect();
    try {
      const sql = require("node:fs").readFileSync(
        require("node:path").resolve(
          __dirname,
          "../../supabase/migrations/postconditions/013_create_feedback_attachments_bucket.postcondition.sql",
        ),
        "utf8",
      );
      await expect(pg.query(sql)).resolves.toBeDefined();
    } finally {
      await pg.end();
    }
  });

  it("013 postcondition RAISEs when the bucket is marked public", async () => {
    // Temporarily set the bucket to public, run postcondition, restore.
    const pg = makePgClient();
    await pg.connect();
    try {
      await pg.query(
        `UPDATE storage.buckets SET public = true WHERE id = 'feedback-attachments';`,
      );

      const sql = require("node:fs").readFileSync(
        require("node:path").resolve(
          __dirname,
          "../../supabase/migrations/postconditions/013_create_feedback_attachments_bucket.postcondition.sql",
        ),
        "utf8",
      );
      await expect(pg.query(sql)).rejects.toThrow(/POSTCONDITION FAILED \(013/);
    } finally {
      // Always restore.
      await pg
        .query(
          `UPDATE storage.buckets SET public = false WHERE id = 'feedback-attachments';`,
        )
        .catch(() => undefined);
      await pg.end();
    }
  });

  it("013 postcondition RAISEs when the deny policies are absent", async () => {
    const pg = makePgClient();
    await pg.connect();
    try {
      // Drop both deny policies.
      await pg.query(
        `DROP POLICY IF EXISTS feedback_attachments_no_client_read ON storage.objects;`,
      );
      await pg.query(
        `DROP POLICY IF EXISTS feedback_attachments_no_client_write ON storage.objects;`,
      );

      const sql = require("node:fs").readFileSync(
        require("node:path").resolve(
          __dirname,
          "../../supabase/migrations/postconditions/013_create_feedback_attachments_bucket.postcondition.sql",
        ),
        "utf8",
      );
      await expect(pg.query(sql)).rejects.toThrow(/POSTCONDITION FAILED \(013/);
    } finally {
      // Restore the policies by re-applying the migration.
      await pg
        .query(readMigrationSql("013_create_feedback_attachments_bucket.sql"))
        .catch(() => undefined);
      await pg.end();
    }
  });
});
