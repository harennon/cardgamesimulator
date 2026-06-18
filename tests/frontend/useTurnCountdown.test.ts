import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, effectScope } from "vue";
import { useTurnCountdown } from "../../src/frontend/composables/useTurnCountdown.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTurnCountdown", () => {
  it("returns remainingSeconds = 0 when turnDeadline is null", () => {
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(null), ref(30));
    });
    expect(result!.remainingSeconds.value).toBe(0);
    scope.stop();
  });

  it("urgency is calm when turnDeadline is null (no timer configured)", () => {
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(null), ref(30));
    });
    // null deadline = no timer: urgency must be calm, not critical
    expect(result!.urgency.value).toBe("calm");
    scope.stop();
  });

  it("computes correct remainingSeconds from a future deadline", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(now + 25000), ref(30));
    });
    // ceil((25000) / 1000) = 25
    expect(result!.remainingSeconds.value).toBe(25);
    scope.stop();
  });

  it("fraction equals remainingSeconds / totalSeconds clamped to [0, 1]", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(now + 15000), ref(30));
    });
    // 15 / 30 = 0.5
    expect(result!.fraction.value).toBe(0.5);
    scope.stop();
  });

  it("urgency is calm when remaining > 10s", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(now + 20000), ref(30));
    });
    expect(result!.urgency.value).toBe("calm");
    scope.stop();
  });

  it("urgency is warning when 5 < remaining <= 10", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(now + 8000), ref(30));
    });
    expect(result!.urgency.value).toBe("warning");
    scope.stop();
  });

  it("urgency is critical when remaining <= 5", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(now + 3000), ref(30));
    });
    expect(result!.urgency.value).toBe("critical");
    scope.stop();
  });

  it("urgency is critical at exactly 5s remaining", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(now + 5000), ref(30));
    });
    expect(result!.urgency.value).toBe("critical");
    scope.stop();
  });

  it("urgency is warning at exactly 10s remaining", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(now + 10000), ref(30));
    });
    expect(result!.urgency.value).toBe("warning");
    scope.stop();
  });

  it("updates remainingSeconds when turnDeadline ref changes", async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const deadline = ref<number | null>(now + 20000);
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(deadline, ref(30));
    });
    expect(result!.remainingSeconds.value).toBe(20);

    // Simulate new turn: new deadline
    deadline.value = now + 30000;
    // Vue watchers are synchronous with nextTick — trigger it
    await Promise.resolve();
    expect(result!.remainingSeconds.value).toBe(30);
    scope.stop();
  });

  it("clears interval on scope disposal", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const scope = effectScope();
    scope.run(() => {
      useTurnCountdown(ref(null), ref(30));
    });
    scope.stop();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("fraction clamps to 1.0 when remaining > totalSeconds (extended first turn)", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    // deadline is 60s in future but totalSeconds is 30 — first turn doubled
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(now + 60000), ref(30));
    });
    // 60 / 30 = 2.0, clamped to 1.0
    expect(result!.fraction.value).toBe(1.0);
    scope.stop();
  });

  it("returns 0 remaining when deadline is in the past", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(now - 5000), ref(30));
    });
    expect(result!.remainingSeconds.value).toBe(0);
    scope.stop();
  });

  it("decrements remainingSeconds each second via interval", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(now + 15000), ref(30));
    });
    expect(result!.remainingSeconds.value).toBe(15);

    vi.advanceTimersByTime(3000);
    expect(result!.remainingSeconds.value).toBe(12);
    scope.stop();
  });

  it("fraction is 0 when totalSeconds is 0 or negative", () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const scope = effectScope();
    let result: ReturnType<typeof useTurnCountdown> | undefined;
    scope.run(() => {
      result = useTurnCountdown(ref(now + 15000), ref(0));
    });
    expect(result!.fraction.value).toBe(0);
    scope.stop();
  });
});
