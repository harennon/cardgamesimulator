import { test as setup } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import * as fs from "node:fs";
import * as path from "node:path";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://localhost:54321";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

// Test user credentials — created in Supabase during setup
const TEST_USERS = [
  { email: "e2e-player1@test.local", password: "testpass123", name: "Player1" },
  { email: "e2e-player2@test.local", password: "testpass123", name: "Player2" },
  { email: "e2e-player3@test.local", password: "testpass123", name: "Player3" },
  { email: "e2e-player4@test.local", password: "testpass123", name: "Player4" },
];

setup("create test users and save auth state", async () => {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Run: export SUPABASE_SERVICE_ROLE_KEY=$(supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2-)",
    );
  }
  if (!SUPABASE_ANON_KEY) {
    throw new Error(
      "SUPABASE_ANON_KEY is not set. Run: export SUPABASE_ANON_KEY=$(supabase status -o env | grep ANON_KEY | cut -d= -f2-)",
    );
  }

  // Admin client for user creation (uses service_role key)
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws },
  });

  // Anon client for sign-in (mimics what the app does)
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws },
  });

  // Ensure .auth directory exists
  const authDir = path.resolve(__dirname, ".auth");
  fs.mkdirSync(authDir, { recursive: true });

  for (let i = 0; i < TEST_USERS.length; i++) {
    const user = TEST_USERS[i]!;

    // Create user via admin API (idempotent — ignores "already registered" errors)
    await adminClient.auth.admin.createUser({
      email: user.email,
      password: user.password,
      email_confirm: true, // Skip email confirmation
      user_metadata: { display_name: user.name },
    });

    // Sign in to get session tokens
    const { data, error } = await anonClient.auth.signInWithPassword({
      email: user.email,
      password: user.password,
    });

    if (error || !data.session) {
      throw new Error(
        `Failed to sign in test user ${user.email}: ${error?.message}`,
      );
    }

    // Write storageState JSON that Playwright can load directly.
    // The frontend reads tokens from localStorage under the Supabase storage key.
    const storageKey = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
    const storageState = {
      cookies: [],
      origins: [
        {
          origin: "http://localhost:5173",
          localStorage: [
            {
              name: storageKey,
              value: JSON.stringify({
                access_token: data.session.access_token,
                refresh_token: data.session.refresh_token,
                expires_at: data.session.expires_at,
                token_type: "bearer",
                user: data.session.user,
              }),
            },
          ],
        },
      ],
    };

    fs.writeFileSync(
      path.join(authDir, `player${i + 1}.json`),
      JSON.stringify(storageState, null, 2),
    );
  }
});
