import { describe, it, expect } from "vitest";
import { ref, nextTick, watch } from "vue";
import {
  deriveConnectionState,
  classifyDisconnect,
} from "../../src/frontend/composables/connectionState.js";
import type { ConnectionState } from "../../src/frontend/composables/connectionState.js";

// ---------------------------------------------------------------------------
// LLD 162 — connection-state mapping helpers
// Pure functions; no socket, no DOM.
// ---------------------------------------------------------------------------

describe("deriveConnectionState", () => {
  it("connected=true, reconnectFailed=false → 'connected'", () => {
    expect(
      deriveConnectionState({ connected: true, reconnectFailed: false }),
    ).toBe("connected");
  });

  it("connected=false, reconnectFailed=false → 'reconnecting'", () => {
    expect(
      deriveConnectionState({ connected: false, reconnectFailed: false }),
    ).toBe("reconnecting");
  });

  it("connected=false, reconnectFailed=true → 'terminal'", () => {
    expect(
      deriveConnectionState({ connected: false, reconnectFailed: true }),
    ).toBe("terminal");
  });

  it("reconnectFailed=true dominates even when connected=true (terminal is sticky)", () => {
    expect(
      deriveConnectionState({ connected: true, reconnectFailed: true }),
    ).toBe("terminal");
  });
});

describe("classifyDisconnect", () => {
  it("'transport close' → 'retry'", () => {
    expect(classifyDisconnect("transport close")).toBe("retry");
  });

  it("'transport error' → 'retry'", () => {
    expect(classifyDisconnect("transport error")).toBe("retry");
  });

  it("'ping timeout' → 'retry'", () => {
    expect(classifyDisconnect("ping timeout")).toBe("retry");
  });

  it("unknown reason → 'retry'", () => {
    expect(classifyDisconnect("some unknown reason")).toBe("retry");
  });

  it("'io server disconnect' → 'terminal' (server-initiated, non-retrying)", () => {
    expect(classifyDisconnect("io server disconnect")).toBe("terminal");
  });

  it("'io client disconnect' → 'ignore' (our own teardown)", () => {
    expect(classifyDisconnect("io client disconnect")).toBe("ignore");
  });
});

// ---------------------------------------------------------------------------
// Event-sequence simulation using refs + the same reducer logic
// Mirrors how useSocket.ts composes these helpers.
// ---------------------------------------------------------------------------

function createSimulatedSocket() {
  const connected = ref(false);
  let _reconnectFailed = false;
  const connectionState = ref<ConnectionState>("connected");
  const reconnectAttempt = ref(0);

  function updateState() {
    connectionState.value = deriveConnectionState({
      connected: connected.value,
      reconnectFailed: _reconnectFailed,
    });
  }

  function onConnect() {
    connected.value = true;
    _reconnectFailed = false;
    reconnectAttempt.value = 0;
    updateState();
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

  return {
    connected,
    connectionState,
    reconnectAttempt,
    onConnect,
    onDisconnect,
    onReconnectAttempt,
    onReconnectFailed,
  };
}

describe("event-sequence simulation", () => {
  it("connect → disconnect(transport close) → reconnect_attempt(3) → reconnect → connect: full happy path", async () => {
    const sim = createSimulatedSocket();

    // Initial connect
    sim.onConnect();
    await nextTick();
    expect(sim.connectionState.value).toBe("connected");
    expect(sim.reconnectAttempt.value).toBe(0);

    // Transient drop
    sim.onDisconnect("transport close");
    await nextTick();
    expect(sim.connectionState.value).toBe("reconnecting");

    // Attempt 3
    sim.onReconnectAttempt(3);
    await nextTick();
    expect(sim.connectionState.value).toBe("reconnecting");
    expect(sim.reconnectAttempt.value).toBe(3);

    // Manager fires 'reconnect', then socket fires 'connect'
    sim.onConnect();
    await nextTick();
    expect(sim.connectionState.value).toBe("connected");
    expect(sim.reconnectAttempt.value).toBe(0);
  });

  it("reconnect_attempt counter resets to 0 on connect", async () => {
    const sim = createSimulatedSocket();
    sim.onConnect();
    sim.onDisconnect("transport error");
    sim.onReconnectAttempt(5);
    expect(sim.reconnectAttempt.value).toBe(5);

    sim.onConnect();
    expect(sim.reconnectAttempt.value).toBe(0);
    expect(sim.connectionState.value).toBe("connected");
  });

  it("all 10 attempts fail → reconnect_failed → terminal", () => {
    const sim = createSimulatedSocket();
    sim.onConnect();
    sim.onDisconnect("transport close");
    for (let i = 1; i <= 10; i++) {
      sim.onReconnectAttempt(i);
    }
    sim.onReconnectFailed();
    expect(sim.connectionState.value).toBe("terminal");
  });

  it("'io server disconnect' → terminal immediately (no reconnect_attempt will fire)", () => {
    const sim = createSimulatedSocket();
    sim.onConnect();
    sim.onDisconnect("io server disconnect");
    expect(sim.connectionState.value).toBe("terminal");
  });

  it("'io client disconnect' → state unchanged (view is tearing down)", () => {
    const sim = createSimulatedSocket();
    sim.onConnect();
    // connectionState is 'connected' here
    sim.onDisconnect("io client disconnect");
    // Must NOT flip to 'reconnecting' or 'terminal'
    expect(sim.connectionState.value).toBe("connected");
  });

  it("watcher receives 'reconnecting' and then 'connected' as state transitions", async () => {
    const sim = createSimulatedSocket();
    const observed: ConnectionState[] = [];

    watch(sim.connectionState, (s) => observed.push(s));

    sim.onConnect();
    await nextTick();

    sim.onDisconnect("transport close");
    await nextTick();

    sim.onConnect();
    await nextTick();

    // Should have seen reconnecting then connected
    expect(observed).toContain("reconnecting");
    expect(observed[observed.length - 1]).toBe("connected");
  });
});
