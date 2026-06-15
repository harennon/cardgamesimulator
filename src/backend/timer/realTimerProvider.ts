import type { TimerProvider, TimerHandle } from "./timerProvider.js";

export class RealTimerProvider implements TimerProvider {
  private nextId = 0;
  private readonly timers: Map<string, NodeJS.Timeout> = new Map();

  schedule(ms: number, callback: () => void): TimerHandle {
    const id = String(this.nextId++);
    const timeout = setTimeout(() => {
      this.timers.delete(id);
      callback();
    }, ms);
    this.timers.set(id, timeout);
    return { id };
  }

  cancel(handle: TimerHandle): void {
    const timeout = this.timers.get(handle.id);
    if (timeout) {
      clearTimeout(timeout);
      this.timers.delete(handle.id);
    }
  }

  /** Cancel all active timers. Called on server shutdown. */
  cancelAll(): void {
    for (const timeout of this.timers.values()) {
      clearTimeout(timeout);
    }
    this.timers.clear();
  }
}
