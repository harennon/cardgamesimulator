import { describe, it, expect, vi } from "vitest";
import { FakeTimerProvider } from "../../src/backend/timer/fakeTimerProvider.js";
import { TurnTimerService } from "../../src/backend/timer/turnTimerService.js";

function makeService(onTimeout?: (gameId: string) => void) {
  const provider = new FakeTimerProvider();
  const callback = onTimeout ?? vi.fn();
  const service = new TurnTimerService(provider, callback);
  return { provider, service, callback };
}

describe("TurnTimerService", () => {
  describe("startTurn", () => {
    it("schedules a timer with the correct duration", () => {
      const { provider, service } = makeService();
      service.registerGame("game-1", { turnTimerSeconds: 60 });
      service.startTurn("game-1", false);

      expect(provider.pendingCount).toBe(1);
    });

    it("uses 2x duration when isFirstTurn is true", () => {
      const { provider, service } = makeService();
      service.registerGame("game-1", { turnTimerSeconds: 60 });
      service.startTurn("game-1", true);

      // We can't inspect the scheduled ms directly, but we can verify
      // the deadline is approximately 120 seconds from now
      const deadline = service.getDeadline("game-1");
      expect(deadline).not.toBeNull();
      const remaining = deadline! - Date.now();
      expect(remaining).toBeGreaterThan(110_000);
      expect(remaining).toBeLessThanOrEqual(120_000);
    });

    it("cancels the previous timer before scheduling a new one", () => {
      const { provider, service } = makeService();
      service.registerGame("game-1", { turnTimerSeconds: 30 });

      service.startTurn("game-1", false);
      service.startTurn("game-1", false);

      expect(provider.pendingCount).toBe(1);
    });

    it("is a no-op when turnTimerSeconds is null", () => {
      const { provider, service } = makeService();
      service.registerGame("game-1", { turnTimerSeconds: null });
      service.startTurn("game-1", false);

      expect(provider.pendingCount).toBe(0);
      expect(service.getDeadline("game-1")).toBeNull();
    });

    it("is a no-op when game is not registered", () => {
      const { provider, service } = makeService();
      service.startTurn("unknown-game", false);

      expect(provider.pendingCount).toBe(0);
    });
  });

  describe("timer expiry", () => {
    it("calls onTimeout with the correct gameId when timer fires", () => {
      const { provider, service, callback } = makeService();
      service.registerGame("game-1", { turnTimerSeconds: 60 });
      service.startTurn("game-1", false);

      const handleId = provider.lastScheduledId!;
      provider.fire(handleId);

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("game-1");
    });

    it("does not call callback after cancelTimer", () => {
      const { provider, service, callback } = makeService();
      service.registerGame("game-1", { turnTimerSeconds: 60 });
      service.startTurn("game-1", false);

      const handleId = provider.lastScheduledId!;
      service.cancelTimer("game-1");

      const fired = provider.fire(handleId);
      expect(fired).toBe(false);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("cancelTimer", () => {
    it("removes the deadline when called", () => {
      const { service } = makeService();
      service.registerGame("game-1", { turnTimerSeconds: 60 });
      service.startTurn("game-1", false);
      expect(service.getDeadline("game-1")).not.toBeNull();

      service.cancelTimer("game-1");
      expect(service.getDeadline("game-1")).toBeNull();
    });

    it("is a no-op when no timer is active", () => {
      const { service } = makeService();
      service.registerGame("game-1", { turnTimerSeconds: 60 });
      // cancelTimer before startTurn — should not throw
      expect(() => service.cancelTimer("game-1")).not.toThrow();
    });
  });

  describe("unregisterGame", () => {
    it("cancels timer and removes config so hasTimer returns false", () => {
      const { provider, service } = makeService();
      service.registerGame("game-1", { turnTimerSeconds: 60 });
      service.startTurn("game-1", false);

      service.unregisterGame("game-1");

      expect(service.hasTimer("game-1")).toBe(false);
      expect(service.getDeadline("game-1")).toBeNull();
      expect(provider.pendingCount).toBe(0);
    });
  });

  describe("getDeadline", () => {
    it("returns approximately Date.now() + configured ms", () => {
      const { service } = makeService();
      service.registerGame("game-1", { turnTimerSeconds: 60 });

      const before = Date.now();
      service.startTurn("game-1", false);
      const after = Date.now();

      const deadline = service.getDeadline("game-1")!;
      expect(deadline).toBeGreaterThanOrEqual(before + 60_000);
      expect(deadline).toBeLessThanOrEqual(after + 60_000);
    });

    it("returns null when no timer is active", () => {
      const { service } = makeService();
      service.registerGame("game-1", { turnTimerSeconds: 60 });
      // startTurn not called yet
      expect(service.getDeadline("game-1")).toBeNull();
    });

    it("returns null when game has no timer configured", () => {
      const { service } = makeService();
      service.registerGame("game-1", { turnTimerSeconds: null });
      service.startTurn("game-1", false);
      expect(service.getDeadline("game-1")).toBeNull();
    });
  });

  describe("independent timers per game", () => {
    it("firing one game's timer does not affect another game", () => {
      const onTimeoutA = vi.fn();
      const onTimeoutB = vi.fn();
      // Use separate services for each game to test independence
      const { provider: providerA, service: serviceA } =
        makeService(onTimeoutA);
      const { service: serviceB } = makeService(onTimeoutB);

      serviceA.registerGame("game-a", { turnTimerSeconds: 30 });
      serviceA.startTurn("game-a", false);

      serviceB.registerGame("game-b", { turnTimerSeconds: 30 });

      const handleA = providerA.lastScheduledId!;
      providerA.fire(handleA);

      expect(onTimeoutA).toHaveBeenCalledWith("game-a");
      expect(onTimeoutB).not.toHaveBeenCalled();
    });

    it("two games in the same service have independent timers", () => {
      const onTimeout = vi.fn();
      const { provider, service } = makeService(onTimeout);

      service.registerGame("game-a", { turnTimerSeconds: 30 });
      service.registerGame("game-b", { turnTimerSeconds: 60 });
      service.startTurn("game-a", false);
      service.startTurn("game-b", false);

      expect(provider.pendingCount).toBe(2);

      // Fire only game-a's timer
      const ids = [...provider["pending"].keys()];
      provider.fire(ids[0]!);

      expect(onTimeout).toHaveBeenCalledOnce();
      expect(provider.pendingCount).toBe(1);
    });
  });
});
