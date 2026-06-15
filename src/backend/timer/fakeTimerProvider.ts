import type { TimerProvider, TimerHandle } from "./timerProvider.js";

export class FakeTimerProvider implements TimerProvider {
  private nextId = 0;
  private readonly pending: Map<string, { ms: number; callback: () => void }> =
    new Map();

  schedule(ms: number, callback: () => void): TimerHandle {
    const id = String(this.nextId++);
    this.pending.set(id, { ms, callback });
    return { id };
  }

  cancel(handle: TimerHandle): void {
    this.pending.delete(handle.id);
  }

  /** Manually fire the timer by handle ID. Returns true if a timer was pending. */
  fire(handleId: string): boolean {
    const entry = this.pending.get(handleId);
    if (!entry) return false;
    this.pending.delete(handleId);
    entry.callback();
    return true;
  }

  /** Fire all pending timers. Returns the count fired. */
  fireAll(): number {
    const entries = [...this.pending.values()];
    this.pending.clear();
    entries.forEach((e) => e.callback());
    return entries.length;
  }

  /** Cancel all pending timers without firing them. */
  cancelAll(): void {
    this.pending.clear();
  }

  /** Get the number of pending timers. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Get the handle ID of the most recently scheduled timer. */
  get lastScheduledId(): string | null {
    if (this.pending.size === 0) return null;
    return [...this.pending.keys()].pop()!;
  }
}
