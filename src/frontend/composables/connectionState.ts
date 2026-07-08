/**
 * Pure mapping helpers for connection-state derivation (LLD 162).
 * Kept in a separate module so they are testable without a socket or DOM.
 */

export type ConnectionState = "connected" | "reconnecting" | "terminal";

export interface ConnInputs {
  connected: boolean;
  reconnectFailed: boolean;
}

/**
 * Derive the tri-state ConnectionState from the minimal signal set.
 * `reconnectFailed` dominates — once all attempts are exhausted the state is
 * terminal regardless of any momentary `connected` flip.
 */
export function deriveConnectionState(i: ConnInputs): ConnectionState {
  if (i.reconnectFailed) return "terminal";
  return i.connected ? "connected" : "reconnecting";
}

/**
 * Socket.IO does NOT auto-reconnect for every disconnect reason. Map the
 * disconnect `reason` string to the class the drop should produce:
 *  - "retry":    manager will attempt reconnection → reconnecting banner
 *  - "terminal": manager will NOT retry (server-initiated) → terminal banner
 *  - "ignore":   our own teardown → leave state unchanged
 */
export type DisconnectClass = "retry" | "terminal" | "ignore";

export function classifyDisconnect(reason: string): DisconnectClass {
  if (reason === "io client disconnect") return "ignore";
  // Non-retrying: server explicitly disconnected the socket; needs manual connect().
  if (reason === "io server disconnect") return "terminal";
  // "transport close" | "transport error" | "ping timeout" and anything else
  // the manager treats as retryable.
  return "retry";
}
