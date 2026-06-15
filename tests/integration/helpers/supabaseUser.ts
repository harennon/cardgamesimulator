import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import WebSocket from "ws";
import { getSupabaseUrl, getSupabaseAnonKey } from "./env.js";

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
  displayName: string;
}

// Supabase JS client requires a WebSocket implementation in Node.js < 22.
function makeClient() {
  return createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    realtime: {
      transport: WebSocket as unknown as typeof globalThis.WebSocket,
    },
  });
}

/**
 * Creates a user in the local Supabase instance and returns their JWT.
 * Uses the Supabase JS client signUp flow — exercises the real GoTrue auth server.
 * Email confirmation is disabled in local config, so the token is immediately usable.
 */
export async function createTestUser(displayName?: string): Promise<TestUser> {
  const email = `test-${randomUUID()}@integration.test`;
  const password = "TestPassword123!";
  const resolvedDisplayName = displayName ?? `User-${randomUUID().slice(0, 8)}`;

  const client = makeClient();

  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: resolvedDisplayName },
    },
  });

  if (error || !data.session) {
    throw new Error(
      `Failed to create test user: ${error?.message ?? "no session returned"}. ` +
        `Is Supabase running? Run: supabase start`,
    );
  }

  return {
    id: data.user!.id,
    email,
    accessToken: data.session.access_token,
    displayName: resolvedDisplayName,
  };
}
