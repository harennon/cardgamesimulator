/**
 * Returns the Supabase URL for use in test helpers.
 */
export function getSupabaseUrl(): string {
  return process.env.SUPABASE_URL!;
}

/**
 * Returns the Supabase anon key.
 * Throws a clear error if not set (helps diagnose "forgot to run supabase start").
 */
export function getSupabaseAnonKey(): string {
  const key = process.env.SUPABASE_ANON_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_ANON_KEY is not set. Run `supabase start` and export the env vars.",
    );
  }
  return key;
}
