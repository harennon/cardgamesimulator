# LLD 40: Admin DELETE Endpoint for Feedback

## Scope

**In scope:**

- `DELETE /feedback/:id` endpoint in `FeedbackHandler`, gated behind `FEEDBACK_ADMIN_IDS`
- `deleteFeedback(id: string)` method on the `FeedbackRepository` interface
- `SupabaseDB` implementation using the service-role client (bypasses RLS)
- `--delete <id>` flag in `scripts/feedback.mjs`
- Unit tests for authorization and 404 handling

**Out of scope:**

- Bulk delete
- Soft delete / archiving
- Admin UI for managing feedback
- RLS policy changes (service-role client already bypasses RLS)

---

## Approach

1. **Reuse existing admin gate pattern.** The `GET /feedback` handler already reads `FEEDBACK_ADMIN_IDS` and checks `request.userId` against it. The DELETE handler uses the same `getAdminIds()` helper and the same 403 response pattern.

2. **Register a parameterized route on the Handler's router.** The `Handler` base class only registers `/` routes for GET/PUT/POST. Since DELETE needs `/:id`, `FeedbackHandler` registers `this.router.delete("/:id", ...)` directly in its constructor. This avoids modifying the shared `Handler` base class.

3. **Use the service-role Supabase client for deletion.** RLS has no DELETE policy on the `feedback` table. The `SupabaseDB` already uses the service-role key, so it can delete directly. No RLS policy additions needed.

4. **Return 404 when the row doesn't exist.** The implementation attempts the delete with a `.select()` to confirm the row existed. If no rows are returned, respond with 404.

---

## Interfaces / Types

### FeedbackRepository (modified: `src/backend/database/database.ts`)

```typescript
export interface FeedbackRepository {
  createFeedback(feedback: Feedback): Promise<Feedback>;
  getAllFeedback(): Promise<Feedback[]>;
  deleteFeedback(id: string): Promise<boolean>; // returns true if deleted, false if not found
}
```

### SupabaseDB addition (`src/backend/database/supabaseDb.ts`)

```typescript
public async deleteFeedback(id: string): Promise<boolean> {
  const { data, error } = await this.db
    .from("feedback")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) throw new Error(`deleteFeedback failed: ${error.message}`);
  return (data ?? []).length > 0;
}
```

### FeedbackHandler DELETE method (`src/backend/api/feedback/submitFeedback.ts`)

Add to the constructor:
```typescript
this.router.delete("/:id", async (req, res) => this.delete(req, res));
```

Add method:
```typescript
public async delete(request: Request, response: Response) {
  const userId = request.userId;
  if (!userId || !getAdminIds().has(userId)) {
    response.status(403).json({ error: "Forbidden" });
    return;
  }

  const { id } = request.params;
  const deleted = await feedbackRepo.deleteFeedback(id);
  if (!deleted) {
    response.status(404).json({ error: "Feedback not found" });
    return;
  }

  response.status(200).json({ deleted: id });
}
```

### Script addition (`scripts/feedback.mjs`)

Add `--delete <id>` flag handling after the existing fetch logic:

```javascript
const deleteId = args.includes("--delete")
  ? args[args.indexOf("--delete") + 1]
  : null;

if (deleteId) {
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
```

---

## State Model

No new state. This is a stateless delete operation:

1. Request arrives with `Authorization` header and `:id` param
2. Auth middleware verifies JWT / guest token and sets `request.userId`
3. Handler checks `userId` is in `FEEDBACK_ADMIN_IDS`
4. Handler calls `feedbackRepo.deleteFeedback(id)` which issues `DELETE FROM feedback WHERE id = $1`
5. Row is removed from Postgres (or 404 if not found)

No in-memory cache, no state machine, no side effects.

---

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | Non-admin user calls DELETE | 403 Forbidden (same as GET) |
| 2 | No auth token | 401 from authMiddleware (before handler) |
| 3 | Feedback ID does not exist | 404 `{ error: "Feedback not found" }` |
| 4 | Invalid UUID format for ID | Supabase/Postgres returns 0 rows (not an error), so 404 |
| 5 | `FEEDBACK_ADMIN_IDS` env var not set | `getAdminIds()` returns empty set, all users get 403 |
| 6 | Double-delete (same ID twice) | First call returns 200, second returns 404 (idempotent from caller perspective) |
| 7 | `--delete` flag without an ID argument | Script reads `undefined`, fetch URL will be malformed; add guard to exit with usage message |

---

## Dependencies

- **Existing code:**
  - `src/backend/api/feedback/submitFeedback.ts` — `FeedbackHandler` class and `getAdminIds()` helper
  - `src/backend/database/database.ts` — `FeedbackRepository` interface
  - `src/backend/database/supabaseDb.ts` — `SupabaseDB` class (service-role client)
  - `src/backend/middleware/authMiddleware.ts` — auth middleware already applied to `/feedback` route
  - `scripts/feedback.mjs` — existing admin script

- **No new dependencies or migrations required.** The service-role client already has permission to delete from the `feedback` table.

---

## Test Requirements

### Unit tests (`tests/service/feedbackService.test.ts` or new `tests/api/feedback.test.ts`)

| # | Test | Verifies |
|---|------|----------|
| 1 | DELETE returns 403 when userId is not in FEEDBACK_ADMIN_IDS | Admin gate works |
| 2 | DELETE returns 403 when no userId on request | Missing auth rejected |
| 3 | DELETE returns 404 when feedbackRepo.deleteFeedback returns false | Non-existent ID handled |
| 4 | DELETE returns 200 with `{ deleted: id }` when repo returns true | Happy path |

Test approach: use the same integration test pattern as `tests/integration/feedback.test.ts`. Set `process.env.FEEDBACK_ADMIN_IDS` to the test user's ID before the request, unset after. Use `supertest` against `ctx.app`.

### Integration test (add to `tests/integration/feedback.test.ts`)

| # | Test | Verifies |
|---|------|----------|
| 1 | Admin can delete existing feedback, subsequent GET no longer includes it | End-to-end delete flow |
| 2 | Non-admin gets 403 on DELETE | Auth gate at integration level |
| 3 | DELETE with non-existent ID returns 404 | 404 behavior |
