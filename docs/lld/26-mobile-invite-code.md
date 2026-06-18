# LLD 26: Show Game Room ID / Invite Code Prominently on Mobile

## Scope

### In scope

- Replace the existing `.lobby__invite` section in `GameLobbyView.vue` with a prominent "Casino Chip" styled room code display
- Display the first 8 characters of the game UUID as a formatted, readable short code (uppercase, split into two 4-character groups)
- Tap-to-copy the game ID (full UUID copied to clipboard, short code displayed)
- Interaction states: idle, copied (gold flash + checkmark icon + toast)
- Retain "Copy Full Invite Link" as a secondary action below the code
- Mobile-responsive layout (works at 354px viewport width, the reported issue viewport)

### Out of scope

- Generating a separate short code / alias on the backend (we reuse the existing UUID)
- Changing how `JoinGameView.vue` resolves game codes (it already accepts full UUIDs)
- Adding a "share" native sheet (Web Share API) — can be a follow-up
- Changes to the game-in-progress view (this is lobby only)

---

## Approach

### Key technical decisions

1. **Display first 8 chars of UUID, copy full UUID.** The game ID is a `crypto.randomUUID()` (e.g., `a7f2b9d1-1234-5678-abcd-ef0123456789`). We display the first 8 hex characters uppercased and split as `A7F2 B9D1` for verbal readability. Tapping copies the full UUID, which the join flow already accepts. No backend changes needed.

2. **Frontend-only change.** The game ID is already passed as a prop to `GameLobbyView.vue`. The short code is a computed property derived from it. No new API endpoints, no new shared types, no database changes.

3. **Casino Chip visual treatment (Option A).** Per the approved mockup, the code is displayed in a gold-bordered pill with monospace font, generous letter-spacing, inset shadow evoking a chip edge, and a copy icon. This makes the code the visual centerpiece of the invite section.

4. **Replace, not augment.** The current `.lobby__invite` div (containing only a "Copy Invite Link" button + "Copied!" span) is replaced entirely by the new `.invite-section`. The full-link copy button is retained as a secondary action below the code.

5. **No new composable or component extraction.** The invite section is small enough to live directly in `GameLobbyView.vue` (one computed + one method + two refs). Extracting a component adds overhead for a single-use piece with no reuse potential.

---

## Interfaces / Types

No new TypeScript interfaces or shared types are needed. This is a frontend-only template + style change within an existing component.

### New computed properties in `GameLobbyView.vue`

```typescript
/** First 8 hex chars of gameId, uppercased, split into groups of 4 with a space. */
const shortCode = computed(() => {
  const raw = props.gameId.replace(/-/g, "").slice(0, 8).toUpperCase();
  return `${raw.slice(0, 4)} ${raw.slice(4, 8)}`;
});
```

### New refs

```typescript
const codeCopied = ref(false);
```

### New method

```typescript
async function copyGameCode(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.gameId);
    codeCopied.value = true;
    setTimeout(() => { codeCopied.value = false; }, 2000);
  } catch {
    errorMessage.value = "Could not copy code";
  }
}
```

### Modified method (existing `copyInviteLink`)

Remains as-is — copies the full URL. The `copied` ref is renamed to `linkCopied` to avoid collision with `codeCopied`.

---

## Frontend Design

**Direction: Option A — Casino Chip** (approved).

### Layout structure (template)

```
.invite-section
  span.invite-label         — "Room Code"
  .invite-code (@click)     — tap target
    span.invite-code__text  — "A7F2 B9D1"
    span.invite-code__icon  — copy icon (swaps to checkmark when copied)
  span.invite-toast         — "Copied to clipboard" (v-if codeCopied)
  button.invite-link-btn    — "Copy Full Invite Link" (secondary)
    span (v-if linkCopied)  — "Copied!"
```

### Visual spec

| Property | Value |
|----------|-------|
| Font family (code) | `JetBrains Mono` (monospace fallback: `monospace`) |
| Font size (code) | `1.5rem` |
| Font weight (code) | `700` |
| Letter spacing | `0.2em` |
| Code color | `var(--gold-accent)` / `#c9a84c` |
| Border | `2px solid var(--gold-accent)` |
| Border radius | `10px` |
| Background | `linear-gradient(135deg, rgba(201,168,76,0.08), transparent 50%), rgba(45,24,16,0.8)` |
| Inset shadow (chip edge) | `inset 0 0 0 3px rgba(20,12,8,0.9), inset 0 0 0 5px rgba(201,168,76,0.3)` |
| Outer shadow | `0 4px 16px rgba(0,0,0,0.4)` |
| Padding | `14px 16px` |
| Copy icon | SVG clipboard icon (18x18), positioned absolute right, opacity 0.6 |
| Copied state | Icon swaps to checkmark, gold flash animation (0.4s), toast visible for 2s |

### Interaction states

1. **Idle:** Code displayed with copy icon.
2. **Hover (desktop):** Border brightens to `#d4b45a`, outer shadow gets gold tint.
3. **Active/Tap:** `transform: scale(0.97)` — brief press feedback.
4. **Copied:** Gold flash animation on background. Icon becomes checkmark. Toast text fades in below. Resets after 2s.

### Mobile considerations

- `.lobby__panel` padding already reduces on mobile. The invite code is `width: 100%` within the panel, so it stretches to fill available width.
- The `1.5rem` monospace code text fits comfortably at 354px viewport (8 chars + space + letter-spacing = ~220px).
- Touch target is the entire `.invite-code` div (minimum 48px height met by 14px padding on a 1.5rem line).

---

## State Model

All state is local to `GameLobbyView.vue`:

```
Props (unchanged):
  gameId: string          — full UUID, provided by parent GameView

Local state:
  codeCopied: boolean     — drives toast + icon swap for game code
  linkCopied: boolean     — drives "Copied!" for invite link button (renamed from `copied`)
  errorMessage: string|null — clipboard API failure

Computed:
  shortCode: string       — "A7F2 B9D1" derived from gameId
  inviteLink: string      — existing, unchanged
```

No server state changes. No new WebSocket events. No persistence.

---

## Edge Cases

| # | Case | Handling |
|---|------|----------|
| 1 | `gameId` is shorter than 8 hex chars after stripping dashes | Cannot happen — `crypto.randomUUID()` always produces 32 hex chars. Defensive: `slice(0, 8)` handles any length gracefully. |
| 2 | Clipboard API unavailable (HTTP, older browsers) | `catch` block sets `errorMessage`. User can still manually copy from screen (text is selectable via long-press). |
| 3 | User taps code and invite link rapidly | Independent `codeCopied` / `linkCopied` refs. Both can be true simultaneously without conflict. |
| 4 | Very narrow viewport (< 320px) | At extreme widths, `letter-spacing: 0.2em` may cause overflow. Mitigation: the code container is `overflow: hidden; text-overflow: clip`. Practically irrelevant — 354px (reported viewport) fits with room to spare. |
| 5 | Player wants to share code verbally | The space-separated 4-char groups (`A7F2 B9D1`) are designed for dictation. Recipient types into the existing `/join-game` page's "Game Code" input. The backend `joinGame` handler accepts any string that matches a `gameId` — so recipient must type the full UUID or use the invite link. See "Future consideration" below. |
| 6 | User copies short code but recipient needs full UUID | The clipboard always receives the **full UUID**, not the short display code. So pasting works directly in the join flow. |

**Future consideration (out of scope):** To support verbal sharing (dictating just 8 chars), the join flow would need to accept partial UUID prefix matching on the backend. This is a separate LLD if pursued.

---

## Dependencies

- **No upstream LLD dependencies.** This is a self-contained frontend change.
- **Existing file to modify:** `src/frontend/component/game/GameLobbyView.vue`
- **No new files needed.**
- **Font dependency:** JetBrains Mono. Either add via Google Fonts import in the component's `<style>` or use the existing monospace system fallback. Recommended: add a single `@import` in the component or in the global game styles if not already present.

---

## Test Requirements

### Unit tests (component): `GameLobbyView`

| # | Test | What it verifies |
|---|------|------------------|
| 1 | Renders short code derived from gameId prop (first 8 hex chars, uppercased, space-separated groups of 4) | `shortCode` computed logic |
| 2 | Clicking the invite code element calls `navigator.clipboard.writeText` with the **full** gameId (not the short code) | Correct value copied |
| 3 | After successful copy, `codeCopied` becomes true and resets after 2000ms | Toast lifecycle |
| 4 | When clipboard API throws, displays error message | Error handling |
| 5 | "Copy Full Invite Link" button still copies the full URL | Regression — existing behavior preserved |
| 6 | Short code displays correctly for a standard UUID (e.g., `a7f2b9d1-...` renders as `A7F2 B9D1`) | Formatting |

### Visual verification (manual, mobile device or DevTools)

| # | Test | What it verifies |
|---|------|------------------|
| 1 | At 354x599 viewport, room code is fully visible without truncation | Original bug fix |
| 2 | Tapping code shows gold flash + checkmark icon + "Copied to clipboard" toast | Interaction feedback |
| 3 | Toast disappears after 2 seconds | Timeout behavior |
| 4 | "Copy Full Invite Link" button is visible below the code | Secondary action accessible |
| 5 | Code text is large enough to read aloud easily | Verbal sharing usability |
