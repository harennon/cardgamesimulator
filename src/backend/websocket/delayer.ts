export interface Delayer {
  /** Resolves after `ms` milliseconds (0 in tests). */
  delay(ms: number): Promise<void>;
}

export class RealDelayer implements Delayer {
  delay(ms: number): Promise<void> {
    return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
  }
}

export class ImmediateDelayer implements Delayer {
  delay(): Promise<void> {
    return Promise.resolve();
  }
}
