import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { PlayerPublicInfo } from "@shared/engine-types";
import {
  railSeats,
  isNearLine,
  NEAR_LINE_THRESHOLD,
} from "@/component/game-ui/tonkDisplay";

// ---------------------------------------------------------------------------
// LLD 141 — self chip in TonkSeatRail
//
// Tests cover:
//   - railSeats contract: self included, marked isSelf, sorted first
//   - Self chip rendering invariants (source inspection): no fan, no AI badge/avatar,
//     no disconnected label, shows "You", shows tally with near-150 modifier
//
// Follows the project pattern: pure function / source inspection tests,
// no DOM mounting, no Vue Test Utils.
// ---------------------------------------------------------------------------

function readSource(relPath: string): string {
  return readFileSync(resolve(import.meta.dirname, relPath), "utf-8");
}

const railSource = readSource(
  "../../src/frontend/component/game-ui/TonkSeatRail.vue",
);

// ---------------------------------------------------------------------------
// Self-chip gate — pure function mirror of the disconnected/AI suppression
// predicates, but for the self chip.
// ---------------------------------------------------------------------------

function showsDisconnected(
  seat: Pick<PlayerPublicInfo, "isConnected" | "isAi"> & { isSelf: boolean },
): boolean {
  return !seat.isConnected && !seat.isAi && !seat.isSelf;
}

function showsAiAvatar(seat: { isAi?: boolean; isSelf: boolean }): boolean {
  return !!seat.isAi && !seat.isSelf;
}

function showsAiBadge(seat: { isAi?: boolean; isSelf: boolean }): boolean {
  return !!seat.isAi && !seat.isSelf;
}

// ---------------------------------------------------------------------------
// railSeats — self-chip contract
// ---------------------------------------------------------------------------

describe("railSeats — self chip included (LLD 141)", () => {
  const players: PlayerPublicInfo[] = [
    {
      playerId: "user-1",
      displayName: "Alice",
      cardCount: 5,
      isConnected: true,
    },
    { playerId: "user-2", displayName: "Bob", cardCount: 4, isConnected: true },
    {
      playerId: "user-3",
      displayName: "Carol",
      cardCount: 3,
      isConnected: true,
    },
  ];
  const tallies = [10, 20, 30];

  it("self seat is included and marked isSelf=true", () => {
    const seats = railSeats(players, tallies, 0);
    const self = seats.find((s) => s.seatIndex === 0);
    expect(self).toBeDefined();
    expect(self!.isSelf).toBe(true);
  });

  it("self seat is sorted first regardless of seatIndex", () => {
    // local player is seat 2 (last in natural order)
    const seats = railSeats(players, tallies, 2);
    expect(seats[0]!.seatIndex).toBe(2);
    expect(seats[0]!.isSelf).toBe(true);
  });

  it("non-self seats have isSelf=false", () => {
    const seats = railSeats(players, tallies, 0);
    seats
      .filter((s) => !s.isSelf)
      .forEach((s) => {
        expect(s.isSelf).toBe(false);
      });
  });

  it("self tally is tallies[myPlayerIndex]", () => {
    const seats = railSeats(players, tallies, 1);
    const self = seats.find((s) => s.isSelf);
    expect(self!.tally).toBe(20);
  });

  it("spectator render (myPlayerIndex=-1): no seat is self, all render in seat order", () => {
    const seats = railSeats(players, tallies, -1);
    expect(seats).toHaveLength(3);
    expect(seats.every((s) => !s.isSelf)).toBe(true);
    expect(seats.map((s) => s.seatIndex)).toEqual([0, 1, 2]);
  });

  it("tallies shorter than players: self tally falls back to 0", () => {
    const seats = railSeats(players, [], 0);
    expect(seats.find((s) => s.isSelf)!.tally).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Self-chip invariants: no AI affordances
// ---------------------------------------------------------------------------

describe("Self chip — AI affordances suppressed (LLD 141 Edge Case 8)", () => {
  it("self seat with isAi=false shows no AI avatar", () => {
    expect(showsAiAvatar({ isAi: false, isSelf: true })).toBe(false);
  });

  it("self seat with isAi=true (hypothetical) still shows no AI avatar", () => {
    expect(showsAiAvatar({ isAi: true, isSelf: true })).toBe(false);
  });

  it("self seat with isAi=false shows no AI badge", () => {
    expect(showsAiBadge({ isAi: false, isSelf: true })).toBe(false);
  });

  it("self seat with isAi=true (hypothetical) still shows no AI badge", () => {
    expect(showsAiBadge({ isAi: true, isSelf: true })).toBe(false);
  });

  it("non-self AI seat still shows avatar", () => {
    expect(showsAiAvatar({ isAi: true, isSelf: false })).toBe(true);
  });

  it("non-self AI seat still shows badge", () => {
    expect(showsAiBadge({ isAi: true, isSelf: false })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Self-chip invariants: no disconnected label
// ---------------------------------------------------------------------------

describe("Self chip — disconnected label suppressed (LLD 141 Edge Case 9)", () => {
  it("self seat with isConnected=false does NOT show disconnected label", () => {
    expect(
      showsDisconnected({ isConnected: false, isAi: undefined, isSelf: true }),
    ).toBe(false);
  });

  it("non-self human seat with isConnected=false still shows disconnected label", () => {
    expect(
      showsDisconnected({ isConnected: false, isAi: undefined, isSelf: false }),
    ).toBe(true);
  });

  it("self seat with isConnected=true does NOT show disconnected label", () => {
    expect(
      showsDisconnected({ isConnected: true, isAi: undefined, isSelf: true }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Near-150 warning applied to self chip
// ---------------------------------------------------------------------------

describe("Self chip — near-150 warning (LLD 141)", () => {
  it("tally below threshold: isNearLine is false", () => {
    expect(isNearLine(NEAR_LINE_THRESHOLD - 1)).toBe(false);
  });

  it("tally at threshold: isNearLine is true", () => {
    expect(isNearLine(NEAR_LINE_THRESHOLD)).toBe(true);
  });

  it("tally at 150: isNearLine is true", () => {
    expect(isNearLine(150)).toBe(true);
  });

  it("self row tally at threshold triggers warning", () => {
    const players: PlayerPublicInfo[] = [
      {
        playerId: "user-1",
        displayName: "Alice",
        cardCount: 5,
        isConnected: true,
      },
      {
        playerId: "user-2",
        displayName: "Bob",
        cardCount: 4,
        isConnected: true,
      },
    ];
    const seats = railSeats(players, [NEAR_LINE_THRESHOLD, 10], 0);
    const self = seats.find((s) => s.isSelf)!;
    expect(isNearLine(self.tally)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Source inspection — TonkSeatRail.vue wiring
// ---------------------------------------------------------------------------

describe("TonkSeatRail — self chip source wiring (LLD 141)", () => {
  it("binds tonk-seat--self class when seat.isSelf", () => {
    expect(railSource).toContain("tonk-seat--self");
    expect(railSource).toContain("seat.isSelf");
  });

  it("fan v-if excludes self chip (!compact && !seat.isSelf)", () => {
    expect(railSource).toMatch(/v-if="!compact && !seat\.isSelf"/);
  });

  it("name renders 'You' when seat.isSelf", () => {
    expect(railSource).toContain('"You"');
    expect(railSource).toMatch(/seat\.isSelf.*You|You.*seat\.isSelf/);
  });

  it("tally pill has near-150 modifier keyed on isNearLine(seat.tally)", () => {
    expect(railSource).toContain("tonk-seat__tally--near");
    expect(railSource).toContain("isNearLine(seat.tally)");
  });

  it("AiAvatar v-if gates on !seat.isSelf", () => {
    expect(railSource).toMatch(/AiAvatar[^>]*!seat\.isSelf/);
  });

  it("AiBadge v-if gates on !seat.isSelf", () => {
    expect(railSource).toMatch(/AiBadge[^>]*!seat\.isSelf/);
  });

  it("disconnected label v-if gates on !seat.isSelf", () => {
    // The v-if predicate appears before the class in the template; match either order.
    expect(railSource).toMatch(
      /(!seat\.isSelf[\s\S]*?tonk-seat__disconnected)|(tonk-seat__disconnected[\s\S]*?!seat\.isSelf)/,
    );
  });

  it("imports isNearLine from tonkDisplay", () => {
    expect(railSource).toContain("isNearLine");
  });
});
