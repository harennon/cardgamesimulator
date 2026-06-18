# LLD Hotfix: Invite Link Auth Bypass (Guest Prompt Shown to Registered Users)

## Scope

**Covers:** Fixing the `/game/:gameId/join` route so that authenticated (Supabase-session) users skip the guest entry screen and are joined directly using their registered identity.

**Does NOT cover:** Changes to the backend join API, guest session flow, lobby UI, or any new screens.

## Problem Analysis

The route definition at line 31-36 of `src/frontend/routes.ts`:

```ts
{
  path: "/game/:gameId/join",
  component: GuestEntryView,
  meta: { requiresAuth: false },
  props: true,
}
```

This always renders `GuestEntryView` regardless of auth state. The router guard (line 49-71) only protects `/game/:gameId` (the game view), not `/game/:gameId/join`. When a registered user clicks an invite link, they land on GuestEntryView which asks for a display name — ignoring their existing session.

## Approach

**Solution: Add a beforeEnter guard to the `/game/:gameId/join` route.**

The guard checks for an active Supabase session. If found, it calls the join API with the user's token and redirects to `/game/:gameId`. If no session exists, it falls through to `GuestEntryView` (current behavior).

This is the minimal fix: one route guard addition, no new components, no backend changes.

**Why not handle this in the GuestEntryView component?**
A component-level `onMounted` check would briefly flash the guest form before redirecting. A route guard prevents the component from rendering at all, which is cleaner UX and avoids a layout flash.

**Why not a global beforeEach guard?**
The global guard already handles `/game/:gameId`. Adding `/game/:gameId/join` logic there would mix concerns. A `beforeEnter` on the specific route is more surgical and easier to test.

## Interfaces / Types

No new types needed. The fix uses existing interfaces:

- `getSession()` from `@/service/authService` — returns `Session | null`
- `axiosInstance` from `@/service/http` — already attaches `Authorization` header via interceptor
- `JoinGameRequest` / `JoinGameResponse` from `@shared/model`

## Implementation Specification

### 1. Route guard (src/frontend/routes.ts)

Add a `beforeEnter` guard to the `/game/:gameId/join` route:

```ts
{
  path: "/game/:gameId/join",
  component: GuestEntryView,
  meta: { requiresAuth: false },
  props: true,
  beforeEnter: async (to) => {
    const session = await getSession();
    if (!session) return; // Not authenticated — show GuestEntryView

    const gameId = to.params.gameId as string;
    try {
      const joinRequest: JoinGameRequest = { gameId };
      await axiosInstance.post<JoinGameResponse>("/api/joinGame", joinRequest);
      return { path: `/game/${gameId}` };
    } catch (error: unknown) {
      const e = error as { response?: { status?: number } };
      if (e.response?.status === 404) {
        // Game not found — let GuestEntryView handle error display?
        // No: redirect to home with error state, or fall through.
        // Simplest: fall through to GuestEntryView which has error handling.
        // But that's wrong for a registered user. Redirect to home.
        return { path: "/", query: { error: "game-not-found" } };
      }
      // For 409 (already in game / game full) or other errors:
      // If user is already in the game, the backend returns 200.
      // If game is full (409), redirect to game page — they might be a spectator.
      // For any unexpected error, redirect to the game page and let GameView handle it.
      return { path: `/game/${gameId}` };
    }
  },
}
```

### 2. Import additions (src/frontend/routes.ts)

Add to the existing imports:

```ts
import { axiosInstance } from "@/service/http";
import type { JoinGameRequest, JoinGameResponse } from "@shared/model";
```

`getSession` is already imported.

### 3. No backend changes

The backend `JoinGameHandler` already:
- Accepts Supabase JWT tokens via the auth middleware
- Extracts `displayName` from `user_metadata.display_name` (line 147 of authMiddleware.ts)
- Handles "already in game" gracefully (returns 200, line 96-97 of joinGame.ts)
- Deduplicates display names

The `axiosInstance` interceptor already attaches the Supabase access token (line 7-10 of http.ts).

## State Model

No new state. The guard is stateless — it checks the existing Supabase session (stored in localStorage by the Supabase client) and makes a single API call.

Flow:
```
User clicks invite link (/game/:gameId/join)
  → beforeEnter guard fires
  → getSession() checks Supabase localStorage
  → Session exists?
    YES → POST /api/joinGame with token → redirect to /game/:gameId
    NO  → return (render GuestEntryView as before)
```

## Edge Cases

1. **Session exists but token is expired** — `getSession()` returns null when the refresh token is also invalid. The Supabase client auto-refreshes valid refresh tokens. If both are expired, user sees GuestEntryView (acceptable — they can sign in from the link at the bottom).

2. **Network error during join API call** — The guard catches the error. Since we cannot determine if the user is already in the game, redirect to `/game/:gameId}`. The GameView guard will re-evaluate access.

3. **Game is full (409)** — Registered user cannot join. Redirect to `/game/:gameId`. If they are already a player (rejoin), the backend returns 200 anyway. If truly full and they are not a player, GameView will show an appropriate error or spectator option.

4. **Game not found (404)** — Redirect to `/` with a query param. The HomeView can optionally display a "Game not found" toast (not required in this hotfix).

5. **User already in the game** — Backend returns 200 with the game info. Guard redirects to `/game/:gameId`. This covers the "refresh after joining" case.

6. **Race condition: session initializing** — `getSession()` awaits the Supabase client check. If the page loads before the session is restored from localStorage, Supabase's `getSession()` may briefly return null. This is acceptable: user sees GuestEntryView momentarily, then can click "Sign in" link. This is an existing limitation of the Supabase JS client and does not regress from current behavior.

7. **Guest with active cookie hitting this route directly** — The guard only checks Supabase session, not guest cookies. A guest with a cookie but no Supabase session falls through to GuestEntryView as before. This is correct.

## Dependencies

- `src/frontend/service/authService.ts` — `getSession()` (exists)
- `src/frontend/service/http.ts` — `axiosInstance` with auth interceptor (exists)
- `src/backend/api/game/joinGame.ts` — accepts Supabase JWT, handles idempotent join (exists)
- `@shared/model` — `JoinGameRequest`, `JoinGameResponse` types (exist)

No new dependencies. No backend changes required.

## Test Requirements

### Unit Tests

1. **Route guard: authenticated user is redirected past GuestEntryView**
   - Mock `getSession()` to return a valid session
   - Mock `axiosInstance.post` to return 200
   - Assert the guard returns `{ path: '/game/:gameId' }`

2. **Route guard: unauthenticated user falls through to GuestEntryView**
   - Mock `getSession()` to return null
   - Assert the guard returns `undefined` (no redirect)

3. **Route guard: join API returns 404 (game not found)**
   - Mock `getSession()` to return a valid session
   - Mock `axiosInstance.post` to reject with 404
   - Assert the guard returns `{ path: '/', query: { error: 'game-not-found' } }`

4. **Route guard: join API returns 409 (game full)**
   - Mock `getSession()` to return a valid session
   - Mock `axiosInstance.post` to reject with 409
   - Assert the guard returns `{ path: '/game/:gameId' }`

5. **Route guard: network error**
   - Mock `getSession()` to return a valid session
   - Mock `axiosInstance.post` to reject with no response
   - Assert the guard returns `{ path: '/game/:gameId' }`

### Integration Tests (E2E)

6. **Registered user clicking invite link joins directly**
   - Sign in as a registered user
   - Navigate to `/game/:gameId/join`
   - Assert: user lands on `/game/:gameId` (game lobby), not on guest entry screen
   - Assert: player's registered display name appears in the lobby

7. **Unauthenticated user clicking invite link sees guest entry**
   - Clear all auth state
   - Navigate to `/game/:gameId/join`
   - Assert: GuestEntryView is rendered (data-testid="guest-entry" is visible)

### Regression

8. **Guest flow still works end-to-end** — existing guest E2E tests pass without modification.
9. **Registered user flow via /join-game page** — unaffected (different route, requires auth).
