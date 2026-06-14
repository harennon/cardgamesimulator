export interface TimerHandle {
  readonly id: string;
}

export interface TimerProvider {
  /** Schedule a callback after `ms` milliseconds. Returns a handle for cancellation. */
  schedule(ms: number, callback: () => void): TimerHandle;
  /** Cancel a scheduled timer. No-op if already fired or cancelled. */
  cancel(handle: TimerHandle): void;
}
