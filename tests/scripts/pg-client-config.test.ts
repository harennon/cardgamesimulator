import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM helper (no .d.ts); typed via JSDoc only.
import { buildClientConfig } from "../../scripts/lib/pg-client-config.mjs";

// ---------------------------------------------------------------------------
// pg.Client connection-config selection (issue #173). Pure-function unit tests
// against inline env objects — no DB, no connection. Proves: SUPABASE_DB_URL set
// → connectionString + ssl rejectUnauthorized:false (prod pooler path);
// unset/empty → local individual-var defaults with no ssl (local/CI path
// untouched); individual DB_* vars honored when no URL is present.
// ---------------------------------------------------------------------------

describe("buildClientConfig — connection-string (prod pooler) path", () => {
  it("uses connectionString + ssl rejectUnauthorized:false when SUPABASE_DB_URL is set", () => {
    const url =
      "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
    const config = buildClientConfig({ SUPABASE_DB_URL: url });
    expect(config).toEqual({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
    });
  });

  it("ignores individual DB_* vars when SUPABASE_DB_URL is set", () => {
    const url =
      "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
    const config = buildClientConfig({
      SUPABASE_DB_URL: url,
      DB_HOST: "should-be-ignored",
      DB_PORT: "1111",
      DB_USER: "ignored",
    });
    expect(config).toEqual({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
    });
  });
});

describe("buildClientConfig — local/CI (individual-var) path", () => {
  it("falls back to localhost defaults with no ssl when SUPABASE_DB_URL is unset", () => {
    const config = buildClientConfig({});
    expect(config).toEqual({
      host: "localhost",
      port: 54322,
      user: "postgres",
      password: "postgres",
      database: "postgres",
    });
    expect("ssl" in config).toBe(false);
  });

  it("treats an empty SUPABASE_DB_URL as unset (falls back to defaults)", () => {
    const config = buildClientConfig({ SUPABASE_DB_URL: "" });
    expect(config).toEqual({
      host: "localhost",
      port: 54322,
      user: "postgres",
      password: "postgres",
      database: "postgres",
    });
    expect("ssl" in config).toBe(false);
  });

  it("honors individual DB_* vars when no URL is present", () => {
    const config = buildClientConfig({
      DB_HOST: "db.internal",
      DB_PORT: "6543",
      DB_USER: "app",
      DB_PASSWORD: "secret",
      DB_NAME: "cards",
    });
    expect(config).toEqual({
      host: "db.internal",
      port: 6543,
      user: "app",
      password: "secret",
      database: "cards",
    });
    expect("ssl" in config).toBe(false);
  });
});
