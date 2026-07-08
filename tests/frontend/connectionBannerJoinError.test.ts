import { describe, it, expect } from "vitest";
import { ref, computed, watch, nextTick } from "vue";
import {
  deriveConnectionState,
  classifyDisconnect,
} from "../../src/frontend/composables/connectionState.js";
import type { ConnectionState } from "../../src/frontend/composables/connectionState.js";

// ---------------------------------------------------------------------------
// LLD 162 — "connection error does NOT set joinError while a board is live"
//
// Transcribes the new GameView rule as a ref-driven simulation:
//   - A transient connect_error/disconnect while displayPhase is a live-board
//     phase MUST NOT mutate joinError.
//   - SERVER_FULL (via terminalError) DOES set joinError.
//   - Recovery: after reconnecting → connected, joinError stays null and
//     disabledReason returns to null (controls re-enable without reload).
// ---------------------------------------------------------------------------

type DisplayPhase =
  | "CREATED"
  | "IN_PROGRESS"
  | "SHOW_FINAL_PLAY"
  | "SHOW_TRICK_RESULT"
  | "COMPLETED";

const LIVE_BOARD_PHASES: DisplayPhase[] = [
  "IN_PROGRESS",
  "SHOW_FINAL_PLAY",
  "SHOW_TRICK_RESULT",
];

/**
 * Replicates the reactive logic from GameView.vue relevant to this test:
 *   - joinError only receives terminalError (not transient connect_errors).
 *   - connectionState is derived from Manager events.
 *   - disabledReason is computed from connectionState.
 */
function createGameViewState(initialPhase: DisplayPhase = "IN_PROGRESS") {
  const displayPhase = ref<DisplayPhase>(initialPhase);
  const joinError = ref<string | null>(null);
  const terminalError = ref<string | null>(null);

  // Mirror the LLD 162 rule: terminalError → joinError, nothing else touches it.
  watch(terminalError, (err) => {
    if (err) joinError.value = err;
  });

  const connected = ref(false);
  let _reconnectFailed = false;
  const connectionState = ref<ConnectionState>("connected");
  const reconnectAttempt = ref(0);

  function _updateState() {
    connectionState.value = deriveConnectionState({
      connected: connected.value,
      reconnectFailed: _reconnectFailed,
    });
  }

  function onConnect() {
    connected.value = true;
    _reconnectFailed = false;
    reconnectAttempt.value = 0;
    _updateState();
  }

  function onDisconnect(reason: string) {
    connected.value = false;
    const cls = classifyDisconnect(reason);
    if (cls === "ignore") return;
    if (cls === "terminal") {
      connectionState.value = "terminal";
      return;
    }
    connectionState.value = "reconnecting";
  }

  function onReconnectAttempt(attempt: number) {
    connectionState.value = "reconnecting";
    reconnectAttempt.value = attempt;
  }

  function onReconnectFailed() {
    _reconnectFailed = true;
    connectionState.value = "terminal";
  }

  /** Simulates connect_error for a non-SERVER_FULL reason (transient). */
  function onTransientConnectError() {
    // LLD 162: transient connect_error does NOT write joinError or terminalError.
    connected.value = false;
    // connectionState is governed by disconnect/reconnect_attempt events,
    // not by connect_error.
  }

  /** Simulates connect_error with SERVER_FULL (terminal handshake failure). */
  function onServerFull() {
    terminalError.value = "Server is at capacity. Please try again shortly.";
  }

  const disabledReason = computed<string | null>(() => {
    if (connectionState.value === "reconnecting") return "Reconnecting…";
    if (connectionState.value === "terminal")
      return "Disconnected — reload to rejoin";
    return null;
  });

  return {
    displayPhase,
    joinError,
    terminalError,
    connectionState,
    reconnectAttempt,
    disabledReason,
    onConnect,
    onDisconnect,
    onReconnectAttempt,
    onReconnectFailed,
    onTransientConnectError,
    onServerFull,
  };
}

describe("transient connect_error while board is live — joinError stays null", () => {
  for (const phase of LIVE_BOARD_PHASES) {
    it(`displayPhase=${phase}: transient connect_error does NOT set joinError`, async () => {
      const gv = createGameViewState(phase);

      gv.onConnect(); // initial connect
      await nextTick();

      gv.onTransientConnectError(); // transient error during reconnect cycle
      await nextTick();

      expect(gv.joinError.value).toBeNull();
    });
  }

  it("disconnect(transport close) while IN_PROGRESS does NOT set joinError", async () => {
    const gv = createGameViewState("IN_PROGRESS");

    gv.onConnect();
    await nextTick();

    gv.onDisconnect("transport close");
    await nextTick();

    expect(gv.joinError.value).toBeNull();
    expect(gv.connectionState.value).toBe("reconnecting");
  });

  it("disconnect while IN_PROGRESS sets connectionState to 'reconnecting'", () => {
    const gv = createGameViewState("IN_PROGRESS");

    gv.onConnect();
    gv.onDisconnect("transport error");

    expect(gv.connectionState.value).toBe("reconnecting");
  });
});

describe("SERVER_FULL sets joinError (board-less terminal path)", () => {
  it("terminalError → joinError is set", async () => {
    const gv = createGameViewState("IN_PROGRESS");

    gv.onConnect();
    await nextTick();

    gv.onServerFull();
    await nextTick();

    expect(gv.joinError.value).toBe(
      "Server is at capacity. Please try again shortly.",
    );
  });
});

describe("recovery assertion — after reconnect joinError stays null and controls re-enable", () => {
  it("drop → reconnecting → connected: joinError never set, disabledReason clears", async () => {
    const gv = createGameViewState("IN_PROGRESS");

    // Board is live; player connects
    gv.onConnect();
    await nextTick();
    expect(gv.joinError.value).toBeNull();
    expect(gv.disabledReason.value).toBeNull();

    // Network drop
    gv.onDisconnect("transport close");
    await nextTick();
    expect(gv.joinError.value).toBeNull(); // never set
    expect(gv.connectionState.value).toBe("reconnecting");
    expect(gv.disabledReason.value).toBe("Reconnecting…");

    // Manager retrying
    gv.onReconnectAttempt(2);
    await nextTick();
    expect(gv.joinError.value).toBeNull();

    // Successful reconnect
    gv.onConnect();
    await nextTick();

    // Primary regression guard: joinError was never touched
    expect(gv.joinError.value).toBeNull();
    // Controls re-enable automatically (no reload needed)
    expect(gv.disabledReason.value).toBeNull();
    expect(gv.connectionState.value).toBe("connected");
  });

  it("10 failed attempts → terminal: joinError still null, disabledReason is terminal message", async () => {
    const gv = createGameViewState("IN_PROGRESS");

    gv.onConnect();
    gv.onDisconnect("transport close");
    for (let i = 1; i <= 10; i++) {
      gv.onReconnectAttempt(i);
    }
    gv.onReconnectFailed();
    await nextTick();

    expect(gv.joinError.value).toBeNull();
    expect(gv.connectionState.value).toBe("terminal");
    expect(gv.disabledReason.value).toBe("Disconnected — reload to rejoin");
  });
});

describe("disabledReason computed", () => {
  it("null when connected", () => {
    const gv = createGameViewState("IN_PROGRESS");
    gv.onConnect();
    expect(gv.disabledReason.value).toBeNull();
  });

  it("'Reconnecting…' when reconnecting", () => {
    const gv = createGameViewState("IN_PROGRESS");
    gv.onConnect();
    gv.onDisconnect("transport close");
    expect(gv.disabledReason.value).toBe("Reconnecting…");
  });

  it("'Disconnected — reload to rejoin' when terminal", () => {
    const gv = createGameViewState("IN_PROGRESS");
    gv.onConnect();
    gv.onDisconnect("transport close");
    gv.onReconnectFailed();
    expect(gv.disabledReason.value).toBe("Disconnected — reload to rejoin");
  });

  it("banner predicate does not reference the local seat (spectator parity)", () => {
    // The banner is shown solely based on connectionState, which is independent
    // of whether the local player has a seat. Assert disabledReason derives
    // purely from connectionState (no gameState.you reference).
    const gv = createGameViewState("IN_PROGRESS");
    // Even without ever setting gameState.you, disabledReason correctly follows
    // connectionState.
    gv.onDisconnect("transport close");
    expect(gv.disabledReason.value).toBe("Reconnecting…");

    gv.onConnect();
    expect(gv.disabledReason.value).toBeNull();
  });
});
