# Customer Experience — Card Game Simulator

Core user flows with key edge cases. ASCII wireframes for primary screens.

---

## Interaction Principles

1. **Zero friction to play.** Invite link → pick a name → you're in. No signup required. Registration is an upgrade path, not a gate.
2. **State is always visible.** Whose turn it is, what was last played, how many cards each player has — always on screen.
3. **Actions are obvious.** If it's your turn, the action panel shows what you can do. If it's not your turn, actions are disabled. No guessing.
4. **Errors are recoverable.** Disconnect? Reconnect and continue. Timeout? Auto-pass and game continues. Invalid link? Clear message with path forward.
5. **No dead ends.** Every screen has a clear next action. Game over → rematch or home. Lobby empty → share link. Not your turn → watch the log.
6. **Guests are first-class players.** During gameplay, guests and registered users are indistinguishable. The only difference is post-game persistence.

---

## User Types

| Type           | Identity                                | Capabilities                                                   | Persistence                                             |
| -------------- | --------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| **Guest**      | Temporary display name (chosen by user) | Spectate, join games, play, rematch                            | None — stats, history, and identity lost on session end |
| **Registered** | Email + password via Supabase Auth      | Everything guests can do + stats, history, host (create) games | Full — stats, game history, persistent identity         |

Guests can do almost everything — the only incentives to register are persistent stats/history and the ability to host (create) games. This keeps the barrier to play as low as possible: a friend shares a link, you pick a name, you're in.

---

## User Flows

### 1. Guest Flow (Join via Invite Link)

**Happy path:**

1. Guest receives invite link from a friend
2. Clicks link → lands on guest entry screen
3. Enters a display name (no email/password needed)
4. Joins game lobby directly (or spectates if game is in progress)
5. Plays the game normally — same experience as registered users during gameplay

**Edge cases:**

- Guest refreshes the page → session cookie preserves guest identity for the game in progress
- Guest closes browser → gone permanently. Seat opens up (or auto-pass if mid-game).
- Guest wants to register after playing → "Save your stats" prompt on game over screen, sign up preserves the game just played
- Display name taken in this game → append number or prompt to choose another

```
┌─────────────────────────────────────┐
│         JOIN AS GUEST               │
├─────────────────────────────────────┤
│                                     │
│  Choose a display name:             │
│  [ __________________ ]             │
│                                     │
│         ┌──────────────────┐        │
│         │   Join Game      │        │
│         └──────────────────┘        │
│                                     │
│  ─────────── or ───────────         │
│                                     │
│  ┌──────────────────────────────┐   │
│  │  Sign up for stats & history │   │
│  └──────────────────────────────┘   │
│                                     │
└─────────────────────────────────────┘
```

---

### 2. Sign Up / Log In

**Happy path:**

1. User lands on home page (via direct URL or invite link)
2. If not authenticated → redirect to login screen
3. User signs up (email + password) or logs in
4. Redirect to home page (or directly to game if arriving via invite link)

**Edge cases:**

- Invalid credentials → inline error, no page reload
- Arriving via invite link while unauthenticated → store intended destination, redirect to login, then forward to game after auth
- Already logged in → skip auth, show home

---

### 3. Create a Game

**Happy path:**

1. From home, user clicks "Create Game"
2. Select game type (Big2)
3. Configure options (player count: 2–4, turn timer: off / 30s / 60s / 90s)
4. Click "Create" → game lobby created, user is host
5. User receives invite link/code to share with friends

**Edge cases:**

- User navigates away before anyone joins → game stays in CREATED state, accessible via link until timeout/cleanup

```
┌─────────────────────────────────────┐
│         CREATE A GAME               │
├─────────────────────────────────────┤
│                                     │
│  Game Type:  [ Big2        ▾ ]      │
│                                     │
│  Players:    [ 4           ▾ ]      │
│                                     │
│  Turn Timer: [ 60 seconds  ▾ ]      │
│                                     │
│         ┌──────────────────┐        │
│         │   Create Game    │        │
│         └──────────────────┘        │
│                                     │
└─────────────────────────────────────┘
```

---

### 4. Join a Game

**Happy path:**

1. User receives invite link (e.g., `/game/abc123`) or enters game code manually
2. If authenticated → join game lobby directly
3. If not authenticated → login first, then auto-join

**Edge cases:**

- Game is full → error message: "This game is full"
- Game doesn't exist → error message: "Game not found"
- Game already in progress → option to spectate (if spectating enabled)
- User is already in the game → rejoin (reconnect to lobby/game)

```
┌─────────────────────────────────────┐
│         JOIN A GAME                 │
├─────────────────────────────────────┤
│                                     │
│  Game Code: [ ______________ ]      │
│                                     │
│         ┌──────────────────┐        │
│         │    Join Game     │        │
│         └──────────────────┘        │
│                                     │
│  Or paste an invite link directly   │
│  in your browser address bar.       │
│                                     │
└─────────────────────────────────────┘
```

---

### 5. Game Lobby (Waiting for Players)

**Happy path:**

1. Host and joined players see lobby screen
2. Player list shows who's in (with ready indicators)
3. Host sees "Start Game" button (enabled when minimum players joined)
4. Share section shows invite link/code for copying
5. Host clicks "Start Game" → deal cards, transition to game board

**Edge cases:**

- Player disconnects from lobby → removed from player list after timeout, slot reopens
- Host disconnects → either: transfer host to next player, or lobby persists for host to reconnect
- Not enough players to start → "Start Game" button disabled with tooltip

```
┌─────────────────────────────────────────────────┐
│  GAME LOBBY                        Big2 (4P)    │
├─────────────────────────────────────────────────┤
│                                                  │
│  Players (2/4):                                  │
│    ● Alice (host)                                │
│    ● Bob                                         │
│    ○ Waiting...                                  │
│    ○ Waiting...                                  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ Invite: https://game.app/game/abc123       │  │
│  │                              [ Copy Link ] │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Timer: 60s per turn                             │
│                                                  │
│           ┌────────────────────┐                 │
│           │    Start Game      │ (host only)     │
│           └────────────────────┘                 │
│                                                  │
└─────────────────────────────────────────────────┘
```

---

### 6. Gameplay (Big2)

**Happy path:**

1. Cards are dealt — player sees their 13 cards face-up at bottom
2. Opponents shown as card backs with count
3. Turn indicator highlights current player
4. On your turn:
   - Select card(s) from hand (click to toggle selection)
   - Action panel shows valid options: "Play" (enabled when cards are selected) or "Pass"
   - Click "Play" → cards move to center, turn advances
   - Click "Pass" → turn advances
5. When not your turn: hand is visible but actions disabled, watch others play
6. Game log shows recent plays ("Alice played: 7♠ 7♥" / "Bob passed")
7. Repeat until someone empties their hand → game over

**Edge cases:**

- Turn timer expires → server auto-passes, notification shown ("You ran out of time")
- Player disconnects mid-game → game pauses (short timeout), then auto-passes for them if they don't reconnect
- Invalid combo submitted → server rejects with error message shown inline; selection preserved so user can adjust
- Reconnection → player rejoins, receives current game state, continues from where they were

```
┌─────────────────────────────────────────────────────────────┐
│  Bob (9 cards)         Charlie (11 cards)      Dave (8 cards)│
│  ┌┐┌┐┌┐┌┐┌┐┌┐┌┐┌┐┌┐  ┌┐┌┐┌┐┌┐┌┐┌┐┌┐┌┐┌┐┌┐┌┐ ┌┐┌┐┌┐┌┐┌┐┌┐┌┐┌┐│
│  └┘└┘└┘└┘└┘└┘└┘└┘└┘  └┘└┘└┘└┘└┘└┘└┘└┘└┘└┘└┘ └┘└┘└┘└┘└┘└┘└┘└┘│
├─────────────────────────────────────────────────────────────┤
│                                                              │
│                    Last Play:                                │
│                   ┌────┐ ┌────┐                              │
│                   │ 7♠ │ │ 7♥ │    (Bob — Pair)             │
│                   └────┘ └────┘                              │
│                                                              │
│              ◄ Your turn ►        Timer: 0:42                │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  Your Hand (13 cards):                                       │
│  ┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐┌────┐   │
│  │ 3♣ ││ 4♦ ││ 5♥ ││ 5♠ ││ 7♦ ││ 9♣ ││ J♥ ││ Q♠ ││ K♦ │   │
│  └────┘└────┘└────┘└────┘└────┘└────┘└────┘└────┘└────┘   │
│                    ▲▲ selected                               │
│  ┌────┐┌────┐┌────┐┌────┐                                   │
│  │ K♠ ││ A♣ ││ A♥ ││ 2♠ │                                   │
│  └────┘└────┘└────┘└────┘                                   │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐           Game Log:             │
│  │   Play   │  │   Pass   │           • Bob: Pair 7♠ 7♥     │
│  └──────────┘  └──────────┘           • Charlie: Pass       │
│                                        • Dave: Pass          │
└─────────────────────────────────────────────────────────────┘
```

**Card selection behavior:**

- Click a card → toggles selection (highlighted/raised)
- "Play" button enabled when it is your turn and at least one card is selected (server-authoritative: the client does NOT validate whether the combo beats the current play — invalid combos are rejected by the server with an inline error message, e.g., "Invalid combination" or "Does not beat current play")
- "Pass" is always available on your turn
- When leading a new trick (after everyone else passed), any valid combination is playable
- Client-side combo preview (showing whether selected cards form a valid hand before submitting) is a Phase 5 polish candidate

---

### 7. Spectating

**Happy path:**

1. User opens invite link to a game that's already in progress
2. Shown option: "This game is in progress. Watch as spectator?"
3. Accept → see game board with SpectatorView (card counts, plays, turn order — no hands)
4. Spectators see a simplified board: center play area + player card counts + game log

**Edge cases:**

- Game ends while spectating → see results screen same as players
- Spectator count shown to players (e.g., "2 watching")

```
┌─────────────────────────────────────────────────────────────┐
│  SPECTATING                                  2 watching      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Alice (13)    Bob (9)    Charlie (11)    Dave (8)           │
│                                                              │
│                    Last Play:                                │
│                   ┌────┐ ┌────┐                              │
│                   │ 7♠ │ │ 7♥ │    (Bob — Pair)             │
│                   └────┘ └────┘                              │
│                                                              │
│              Alice's turn         Timer: 0:42                │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  Game Log:                                                   │
│  • Alice: Straight 3♣ 4♦ 5♥ 6♠ 7♦                          │
│  • Bob: Pair 7♠ 7♥                                          │
│  • Charlie: Pass                                            │
│  • Dave: Pass                                               │
│  • Alice's turn (trick winner)                              │
└─────────────────────────────────────────────────────────────┘
```

---

### 8. Game Over + Post-Game

**Happy path (registered):**

1. A player plays their last card(s) → game immediately ends
2. All players see results screen: winner announcement, placement-based scoring, final card counts
3. Options: "Rematch" (same players, new game) or "Back to Home"
4. Stats updated (wins/losses/score)

**Scoring is per-game-type.** Big2 uses placement-based scoring: 1st = 5pts, 2nd = 3pts, 3rd = 1pt, 4th = 0pts. Other game types (e.g., Tonk) will define their own scoring systems.

**Happy path (guest):**

1. Same results screen as registered users
2. Below results: "Sign up to save your stats and play again later"
3. If guest signs up → the game just played is retroactively added to their stats
4. If guest declines → session ends when they leave, no trace

**Edge cases:**

- Player disconnects before seeing results → stats still updated server-side, results visible on reconnect or from profile
- Rematch with fewer players (someone left) → returns to lobby with remaining players, new invites possible
- Guest in rematch → stays as guest, new game starts normally

```
┌─────────────────────────────────────────────────────────────┐
│                      GAME OVER                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│                   🏆 Alice wins!                             │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Player     Place    Cards Left    Points           │    │
│  ├─────────────────────────────────────────────────────┤    │
│  │  Alice      1st      0             5               │    │
│  │  Bob        2nd      3             3               │    │
│  │  Charlie    3rd      7             1               │    │
│  │  Dave       4th      12            0               │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────┐    ┌──────────────────┐               │
│  │     Rematch      │    │   Back to Home   │               │
│  └──────────────────┘    └──────────────────┘               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

### 9. Home / Dashboard

**Happy path:**

1. Authenticated user lands on home page
2. Sees: create game button, join game input, recent game history, personal stats
3. Quick actions: Create Game, Join Game, view past results

```
┌─────────────────────────────────────────────────────────────┐
│  CARD GAME SIMULATOR                    Welcome, Alice       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────┐    ┌─────────────────────┐        │
│  │    Create Game      │    │     Join Game       │        │
│  └─────────────────────┘    └─────────────────────┘        │
│                                                              │
│  ── Your Stats ──────────────────────────────────────       │
│  Games Played: 12    Won: 7    Lost: 5    Win Rate: 58%     │
│                                                              │
│  ── Recent Games ────────────────────────────────────       │
│  Big2 (4P) — Won — 2 hours ago                              │
│  Big2 (3P) — Lost — Yesterday                               │
│  Big2 (4P) — Won — 3 days ago                               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Screen Inventory

| Screen         | When                                   | Key Elements                                                  |
| -------------- | -------------------------------------- | ------------------------------------------------------------- |
| Guest Entry    | Guest arriving via invite link         | Display name input, join button, sign-up nudge                |
| Login/Signup   | Unauthenticated (choosing to register) | Email, password, submit, error messages                       |
| Home           | Authenticated, no active game          | Create, join, stats, history                                  |
| Create Game    | Configuring new game (registered only) | Game type, player count, timer, create button                 |
| Join Game      | Entering code                          | Code input, join button, error states                         |
| Game Lobby     | Waiting for players                    | Player list (guests marked), invite link, start button (host) |
| Game Board     | Active gameplay                        | Hands, center area, action panel, timer, game log             |
| Spectator View | Watching active game                   | Card counts, plays, turn indicator, game log                  |
| Game Over      | Game completed                         | Winner, scores, rematch/home, sign-up prompt (guests)         |
