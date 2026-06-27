import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Tests for the room-code reconciliation logic that lives across GameView.vue
// (seed roomCode from REST, sync from lobby:state) and GameBoard.vue (prefer
// the live socket joinCode over the seeded prop). Extracted as pure functions
// mirroring the component logic — same node-env pattern as the other frontend
// tests in this directory.
// ---------------------------------------------------------------------------

/**
 * Mirrors GameBoard.vue `displayCode`:
 *   computed(() => props.gameState.joinCode ?? props.roomCode)
 */
function displayCode(joinCode: string | null, roomCode: string): string {
  return joinCode ?? roomCode;
}

describe("GameBoard displayCode reconciliation", () => {
  it("renders the code from gameState.joinCode when present", () => {
    expect(displayCode("H7K3", "")).toBe("H7K3");
  });

  it("falls back to the roomCode prop when gameState.joinCode is null", () => {
    expect(displayCode(null, "SEED1")).toBe("SEED1");
  });

  it("prefers the live socket joinCode over the seeded roomCode prop", () => {
    // game:state landed with a code; the REST seed is stale/different.
    expect(displayCode("LIVE9", "SEED1")).toBe("LIVE9");
  });

  it("yields empty string (chip renders nothing) when both sources are empty", () => {
    expect(displayCode(null, "")).toBe("");
  });
});

describe("GameView roomCode seeding", () => {
  it("seeds roomCode from the REST getGameState response on mount", () => {
    // mirrors: roomCode.value = game.joinCode ?? ""
    const game = { joinCode: "H7K3" as string | null };
    const roomCode = game.joinCode ?? "";
    expect(roomCode).toBe("H7K3");
  });

  it("seeds roomCode to '' when the REST response has a null joinCode", () => {
    const game = { joinCode: null as string | null };
    const roomCode = game.joinCode ?? "";
    expect(roomCode).toBe("");
  });

  it("syncs roomCode from the lobby:state payload (CREATED games)", () => {
    // mirrors the lobby:state handler: roomCode.value = payload.joinCode
    let roomCode = "";
    const payload = { joinCode: "H7K3" };
    roomCode = payload.joinCode;
    expect(roomCode).toBe("H7K3");
  });
});
