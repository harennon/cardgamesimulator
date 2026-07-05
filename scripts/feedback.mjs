#!/usr/bin/env node
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { renderFeedback } from "./lib/renderFeedback.mjs";

config({ path: ".env.admin" });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
const RAILWAY_URL = process.env.RAILWAY_URL;

if (
  !SUPABASE_URL ||
  !SUPABASE_ANON_KEY ||
  !EMAIL ||
  !PASSWORD ||
  !RAILWAY_URL
) {
  console.error(
    "Missing .env.admin — needs SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_EMAIL, ADMIN_PASSWORD, RAILWAY_URL",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const { data, error: authError } = await supabase.auth.signInWithPassword({
  email: EMAIL,
  password: PASSWORD,
});

if (authError || !data.session) {
  console.error("Auth failed:", authError?.message ?? "no session");
  process.exit(1);
}

const token = data.session.access_token;

const [, , ...args] = process.argv;

// Handle --delete <id> flag
const deleteIdx = args.indexOf("--delete");
if (deleteIdx !== -1) {
  const deleteId = args[deleteIdx + 1];
  if (!deleteId || deleteId.startsWith("--")) {
    console.error("Usage: node feedback.mjs --delete <id>");
    process.exit(1);
  }
  const delRes = await fetch(`${RAILWAY_URL}/feedback/${deleteId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!delRes.ok) {
    console.error("DELETE failed:", delRes.status, await delRes.text());
    process.exit(1);
  }
  console.log(`Deleted feedback ${deleteId}`);
  process.exit(0);
}

const res = await fetch(`${RAILWAY_URL}/feedback`, {
  headers: { Authorization: `Bearer ${token}` },
});

if (!res.ok) {
  console.error("GET /feedback failed:", res.status, await res.text());
  process.exit(1);
}

const rows = await res.json();

const category = args.find((a) => !a.startsWith("--"));
const json = args.includes("--json");

let filtered = rows;
if (category) {
  filtered = rows.filter((r) => r.category === category);
}

console.log(renderFeedback(filtered, { json }));
if (filtered.length === 0) process.exit(0);
