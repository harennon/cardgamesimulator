# LLD 169: Public "Join by room code" for signed-out users — type a 4-letter code without a clickable link

## Scope

**Covers:** A frontend-only entry surface that lets a signed-out user type a room code on the
Home screen, resolve it to a game, and land on the existing guest-entry name prompt — no account,
no clickable invite link.

Specifically:
- A room-code input + inline Join button on the **signed-out branch** of `HomeView.vue`, placed
  as a secondary control above the existing "or" divider and Log In / Sign Up buttons.
- Client-side normalization/validation of the code (4 chars, case-insensitive), matching
  `JoinGameView.vue`.
- Resolution via the existing no-auth `GET /api/games/join/:code` endpoint, then navigation to
  `/game/:gameId/join` (GuestEntryView via `joinRouteGuard`).

**Does NOT cover:**
- Any backend, database, or WebSocket/protocol change. The existing no-auth resolver
  (`server.ts:147`, `/games/join`) is the only resolution call.
- The inviter's share sheet / QR code (that is issue #214).
- Changes to the signed-in Home (Create / Join / Stats) or the authenticated `/join-game`
  (`JoinGameView`) flow — both remain untouched.
- The gated `/join-game` route (`routes.ts:52`, `requiresAuth: true`) is not reused for the
  signed-out path.

## Approach

**Frontend decision: Option A (approved).** A single monospace, letter-spaced code input with an
inline Join button, added to the `v-else` (signed-out) branch of `HomeView.vue`, above the
existing "or"/Log In/Sign Up block.

Key decisions:

1. **No new route.** The signed-out flow does not need a dedicated resolution route. `HomeView`
   already renders at `/` with `requiresAuth: false`. On submit it resolves the code in-place via
   `axiosInstance.get('/api/games/join/:code')`, then `router.push('/game/:gameId/join')`. That
   destination (`routes.ts:55-60`) is `requiresAuth: false` and runs `joinRouteGuard`, which for a
   signed-out user returns `undefined` and renders `GuestEntryView`. This avoids the `requiresAuth`
   redirect entirely (never touches `/join-game`).

2. **Navigate to guest entry, not the board.** On success we push `/game/:gameId/join` (guest name
   prompt), NOT `/game/:gameId`. This mirrors the clickable-invite-link path and ensures the guest
   session is created before hitting the board's guard (`routes.ts:84-95`).

3. **Signed-in users are unchanged.** The code-entry field lives only inside the `v-else`
   (signed-out) branch. Signed-in users keep the authenticated `/join-game` flow (join as
   themselves). No new UI in the `v-if="signedIn"` branch.

4. **Reuse existing primitives.** Uses `flows.css` classes (`form-card__field`,
   `form-card__input`, `form-card__error`, `btn-primary`, `form-card__divider`). No new
   game-entry component; the logic is small enough to live inline in `HomeView.vue`.

5. **Validation matches `JoinGameView`.** Reuse `SHORT_CODE_REGEX = /^[A-Z0-9]{4}$/i` and
   `.trim().toUpperCase()` normalization so `wxyz` and `WXYZ` resolve identically. (The endpoint is
   4-char alphanumeric; "4-letter" is the user-facing framing.)

## Interfaces / Types

No new shared types. Reuse existing `@shared/model`:

```ts
export interface ResolveJoinCodeResponse {
  gameId: string;
}
```

New local state and handler in `HomeView.vue` `<script setup>`:

```ts
const roomCode = ref("");           // raw user input
const codeError = ref("");          // inline error message
const resolving = ref(false);       // in-flight guard for the Join button

const SHORT_CODE_REGEX = /^[A-Z0-9]{4}$/i;

async function joinByCode(): Promise<void>;
```

`joinByCode` behavior:
1. `const code = roomCode.value.trim().toUpperCase();`
2. If `!SHORT_CODE_REGEX.test(code)` → set `codeError` to `"No game found for that code."`, return
   (no request). Preserve `roomCode`.
3. Set `resolving = true`, clear `codeError`.
4. `GET /api/games/join/${code}` → on success `router.push('/game/${gameId}/join')`.
5. On error: `404` → `"No game found for that code."`; no `response` (network) →
   `"Network error. Please try again."`; else → `"Something went wrong. Please try again."`.
   Preserve `roomCode` in all cases.
6. `finally` → `resolving = false`.

Template additions (signed-out branch only), above the existing description/Log In/Sign Up:

```html
<form class="home__code-form" @submit.prevent="joinByCode">
  <label class="form-card__label" for="room-code">Have a room code?</label>
  <div class="home__code-row">
    <input
      class="form-card__input home__code-input"
      id="room-code"
      v-model="roomCode"
      maxlength="4"
      autocomplete="off"
      autocapitalize="characters"
      placeholder="WXYZ"
      data-testid="home-room-code-input"
    />
    <button
      type="submit"
      class="btn-primary home__code-btn"
      :disabled="!roomCode.trim() || resolving"
      data-testid="home-room-code-join"
    >
      {{ resolving ? "…" : "Join" }}
    </button>
  </div>
  <p v-if="codeError" class="form-card__error" data-testid="home-room-code-error">
    {{ codeError }}
  </p>
</form>
<div class="form-card__divider">or</div>
```

Scoped styles: `.home__code-row` is `display:flex; gap:8px;` with the input `flex:1` and the button
shrink-to-content; the input is monospace + letter-spaced + uppercase (`text-transform:uppercase`).

## State Model

- **All state is component-local and in-memory** (`roomCode`, `codeError`, `resolving`). Nothing
  persisted. No store, no cookie written here.
- The only network interaction is the read-only `GET /api/games/join/:code`.
- The guest session (cookie/token) is created later by `GuestEntryView`/`createGuestSession`, not
  by this flow — unchanged from today.
- `signedIn` is already resolved in `onMounted` via `getSession()`; the code field renders only
  when `signedIn === false`.

## Edge Cases

1. **Empty / whitespace-only input:** Join button disabled (`!roomCode.trim()`); Enter submits but
   fails regex → inline error, no request.
2. **Wrong length / non-alphanumeric (e.g. 3 chars, symbols):** fails regex client-side → inline
   `"No game found for that code."`, no request, input preserved.
3. **Lowercase input (`wxyz`):** normalized via `.toUpperCase()` → resolves identically to `WXYZ`.
4. **Unknown/expired code (server 404):** inline `"No game found for that code."`, input
   preserved, NO redirect to login.
5. **Network failure / server 5xx:** inline error, input preserved, button re-enabled.
6. **Double submit / rapid taps:** `resolving` guard disables the button while a request is in
   flight.
7. **User becomes signed-in (session appears):** field is inside `v-else`; if `signedIn` is true it
   is not rendered. Signed-in users use `/join-game`.
8. **Race where resolved game fills before guest entry:** unchanged existing behavior — handled by
   `GuestEntryView`/`joinRouteGuard` (409 → board or full message). Out of scope here.
9. **Mobile width (~320px):** input + button on one row must not overflow; input `flex:1`, button
   fixed min-width, `font-size:16px` on input to prevent iOS zoom (already covered by `flows.css`
   `@media (max-width:767px)`).
10. **Leading/trailing spaces (pasted code):** trimmed before validation.

## Dependencies

Everything required already exists — this is pure wiring:
- `GET /api/games/join/:code` no-auth resolver — `server.ts:147` (`/games/join`), returns
  `ResolveJoinCodeResponse`.
- `/game/:gameId/join` route → `GuestEntryView` with `joinRouteGuard` — `routes.ts:55-60`; guard
  returns `undefined` for signed-out users (`routes.ts:25`).
- `GuestEntryView.vue` guest name prompt + `createGuestSession` — already functional for
  unauthenticated users.
- `flows.css` primitives (`form-card__input`, `btn-primary`, `form-card__divider`,
  `form-card__error`, `form-card__label`).
- `ResolveJoinCodeResponse` in `@shared/model`.

No new packages, migrations, or backend routes.

## Test Requirements

**Unit / component (HomeView):**
- Signed-out branch renders the room-code input, Join button, and "or" divider above Log In / Sign
  Up.
- Signed-in branch renders Create / Join / Stats and does NOT render the room-code field.
- Valid code (upper and lower case) triggers `GET /api/games/join/<UPPERCASED>` and, on success,
  `router.push('/game/<gameId>/join')` (guest entry) — assert it does NOT push `/game/<gameId>`.
- Invalid-format code (bad length/chars) shows `"No game found for that code."`, makes no HTTP
  request, and preserves the entered value.
- Server 404 shows `"No game found for that code."`, preserves input, and does NOT navigate to
  `/login` or `/`.
- Network error shows `"Network error. Please try again."` and re-enables the button.
- Button disabled when input empty/whitespace and while a request is in flight (`resolving`).

**Integration (routing):**
- From `/` signed-out, submitting a valid resolvable code lands on `GuestEntryView`
  (`/game/:gameId/join`) without hitting the `requiresAuth` login redirect; entering a display name
  then reaches the board — no account, no invite link.
- Signed-in user's `/join-game` flow and Home remain unchanged (regression check).

**Visual / responsive:**
- At ~320px viewport, the input + Join button row does not overflow the card and the input font is
  16px (no iOS zoom).

No backend/security tests needed — no backend surface changes; the resolver was already
intentionally no-auth.

## Frontend Design

Approved direction: **Option A**.

- **Placement:** Inside the `v-else` (signed-out) branch of `HomeView.vue`, as a SECONDARY control
  positioned above a `form-card__divider` ("or") and the existing Log In / Sign Up buttons. The
  primary calls-to-action (Log In / Sign Up) keep their visual weight; the code field is the
  lighter, faster path for someone who was handed a code.
- **Control:** One row — a monospace, letter-spaced, uppercase text input (label "Have a room
  code?", placeholder like `WXYZ`, `maxlength="4"`, `autocapitalize="characters"`) with an inline
  `btn-primary` "Join" button to its right.
- **Primitives:** Reuse `flows.css` (`form-card__label`, `form-card__input`, `btn-primary`,
  `form-card__error`, `form-card__divider`). Only new scoped CSS is the flex row layout
  (`.home__code-row`) and the monospace/letter-spacing on the input. Do NOT invent new game-entry
  UI.
- **Error affordance:** Inline `form-card__error` text below the row using
  `"No game found for that code."` (consistent wording), input value preserved, no full-page
  redirect.
- **Responsive:** Row uses `flex` with `input { flex:1 }` and a shrink-to-content button; verified
  no overflow at ~320px. Input font-size 16px on mobile (inherited from `flows.css` media query).
- **Signed-in users:** No visual change — the field is absent from the `v-if="signedIn"` branch.
