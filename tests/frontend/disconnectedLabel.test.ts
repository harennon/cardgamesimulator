import { describe, it, expect } from "vitest";
import type { PlayerPublicInfo } from "@shared/engine-types";

// Unit tests for the disconnected-label guard added to OpponentRow.vue and
// TonkSeatRail.vue (LLD 125).
//
// The guarded v-if predicate is:
//   !seat.isConnected && !seat.isAi
//
// AI seats (isAi === true) never open a WebSocket, so isConnected is always
// false for them — but that is not a real disconnect. The label must only
// show for genuinely offline human opponents.
//
// Following the project pattern (node environment, no DOM mount): the predicate
// is transcribed as a pure function and tested directly.

function showsDisconnected(
  seat: Pick<PlayerPublicInfo, "isConnected" | "isAi">,
): boolean {
  return !seat.isConnected && !seat.isAi;
}

// ---------------------------------------------------------------------------
// Big2 — OpponentRow.vue
// ---------------------------------------------------------------------------

describe("OpponentRow — disconnected label guard", () => {
  it("AI seat (isAi=true, isConnected=false) does NOT show label", () => {
    const ai: PlayerPublicInfo = {
      playerId: "ai:uuid-1",
      displayName: "CPU 1",
      cardCount: 5,
      isConnected: false,
      isAi: true,
    };
    expect(showsDisconnected(ai)).toBe(false);
  });

  it("human seat (isAi absent, isConnected=false) STILL shows label", () => {
    const human: PlayerPublicInfo = {
      playerId: "user-1",
      displayName: "Alice",
      cardCount: 5,
      isConnected: false,
    };
    expect(showsDisconnected(human)).toBe(true);
  });

  it("human seat (isAi=false, isConnected=false) shows label", () => {
    const human: PlayerPublicInfo = {
      playerId: "user-1",
      displayName: "Alice",
      cardCount: 5,
      isConnected: false,
      isAi: false,
    };
    expect(showsDisconnected(human)).toBe(true);
  });

  it("connected human seat (isConnected=true) does NOT show label", () => {
    const human: PlayerPublicInfo = {
      playerId: "user-1",
      displayName: "Alice",
      cardCount: 5,
      isConnected: true,
    };
    expect(showsDisconnected(human)).toBe(false);
  });

  it("connected AI seat (isConnected=true) does NOT show label", () => {
    // Hypothetical: bots never connect, but the guard is still correct.
    const ai: PlayerPublicInfo = {
      playerId: "ai:uuid-1",
      displayName: "CPU 1",
      cardCount: 5,
      isConnected: true,
      isAi: true,
    };
    expect(showsDisconnected(ai)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tonk — TonkSeatRail.vue (same predicate, same seat fields)
// ---------------------------------------------------------------------------

describe("TonkSeatRail — disconnected label guard", () => {
  it("AI seat (isAi=true, isConnected=false) does NOT show label", () => {
    const ai: PlayerPublicInfo = {
      playerId: "ai:uuid-2",
      displayName: "CPU 2",
      cardCount: 6,
      isConnected: false,
      isAi: true,
    };
    expect(showsDisconnected(ai)).toBe(false);
  });

  it("human seat (isAi absent, isConnected=false) STILL shows label", () => {
    const human: PlayerPublicInfo = {
      playerId: "user-2",
      displayName: "Bob",
      cardCount: 6,
      isConnected: false,
    };
    expect(showsDisconnected(human)).toBe(true);
  });

  it("human seat (isAi=false, isConnected=false) shows label", () => {
    const human: PlayerPublicInfo = {
      playerId: "user-2",
      displayName: "Bob",
      cardCount: 6,
      isConnected: false,
      isAi: false,
    };
    expect(showsDisconnected(human)).toBe(true);
  });

  it("connected human seat (isConnected=true) does NOT show label", () => {
    const human: PlayerPublicInfo = {
      playerId: "user-2",
      displayName: "Bob",
      cardCount: 6,
      isConnected: true,
    };
    expect(showsDisconnected(human)).toBe(false);
  });
});
