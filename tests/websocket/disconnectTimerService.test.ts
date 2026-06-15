import { describe, it, expect, vi } from "vitest";
import { FakeTimerProvider } from "../../src/backend/timer/fakeTimerProvider.js";
import {
  DisconnectTimerService,
  DISCONNECT_GRACE_PERIOD_MS,
} from "../../src/backend/websocket/disconnectTimerService.js";

function makeService(onExpired?: (gameId: string, playerId: string) => void) {
  const provider = new FakeTimerProvider();
  const callback = onExpired ?? vi.fn();
  const service = new DisconnectTimerService(provider, callback);
  return { provider, service, callback };
}

describe("DisconnectTimerService", () => {
  describe("startGracePeriod", () => {
    it("schedules a timer via TimerProvider", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");

      expect(provider.pendingCount).toBe(1);
    });

    it("is idempotent — second call for same player is a no-op", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");
      service.startGracePeriod("game-1", "player-a");

      expect(provider.pendingCount).toBe(1);
    });

    it("allows concurrent timers for different players in the same game", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");
      service.startGracePeriod("game-1", "player-b");

      expect(provider.pendingCount).toBe(2);
    });

    it("allows concurrent timers for the same player in different games", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");
      service.startGracePeriod("game-2", "player-a");

      expect(provider.pendingCount).toBe(2);
    });

    it("uses DISCONNECT_GRACE_PERIOD_MS as the timer duration", () => {
      // Verify the constant is 30 seconds as specified by the LLD
      expect(DISCONNECT_GRACE_PERIOD_MS).toBe(30_000);
    });
  });

  describe("cancelGracePeriod", () => {
    it("cancels the pending timer", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");
      expect(provider.pendingCount).toBe(1);

      service.cancelGracePeriod("game-1", "player-a");

      expect(provider.pendingCount).toBe(0);
    });

    it("timer callback never fires after cancel", () => {
      const { provider, service, callback } = makeService();
      service.startGracePeriod("game-1", "player-a");
      const handleId = provider.lastScheduledId!;

      service.cancelGracePeriod("game-1", "player-a");

      const fired = provider.fire(handleId);
      expect(fired).toBe(false);
      expect(callback).not.toHaveBeenCalled();
    });

    it("clears abandoned status when called after abandonment", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");
      provider.fireAll(); // marks as abandoned

      expect(service.isAbandoned("game-1", "player-a")).toBe(true);

      service.cancelGracePeriod("game-1", "player-a");

      expect(service.isAbandoned("game-1", "player-a")).toBe(false);
    });

    it("is a no-op when player has no timer", () => {
      const { service } = makeService();
      expect(() =>
        service.cancelGracePeriod("game-1", "no-timer-player"),
      ).not.toThrow();
    });

    it("only cancels the specified player's timer", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");
      service.startGracePeriod("game-1", "player-b");

      service.cancelGracePeriod("game-1", "player-a");

      expect(provider.pendingCount).toBe(1);
    });
  });

  describe("timer expiry", () => {
    it("marks player as abandoned when timer fires", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");

      provider.fireAll();

      expect(service.isAbandoned("game-1", "player-a")).toBe(true);
    });

    it("calls onGracePeriodExpired callback with correct gameId and playerId", () => {
      const { provider, service, callback } = makeService();
      service.startGracePeriod("game-1", "player-a");

      provider.fireAll();

      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith("game-1", "player-a");
    });

    it("fires callback with the correct arguments for the right player", () => {
      const { provider, service, callback } = makeService();
      service.startGracePeriod("game-2", "player-xyz");

      const handleId = provider.lastScheduledId!;
      provider.fire(handleId);

      expect(callback).toHaveBeenCalledWith("game-2", "player-xyz");
    });

    it("removes the timer handle after firing (not counted as pending)", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");

      provider.fireAll();

      expect(provider.pendingCount).toBe(0);
    });
  });

  describe("isAbandoned", () => {
    it("returns false for a player who has not disconnected", () => {
      const { service } = makeService();

      expect(service.isAbandoned("game-1", "player-a")).toBe(false);
    });

    it("returns false during grace period (timer scheduled but not fired)", () => {
      const { service } = makeService();
      service.startGracePeriod("game-1", "player-a");

      expect(service.isAbandoned("game-1", "player-a")).toBe(false);
    });

    it("returns true after grace period expires", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");

      provider.fireAll();

      expect(service.isAbandoned("game-1", "player-a")).toBe(true);
    });

    it("returns false for a different player in the same game", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");
      provider.fireAll(); // only player-a expires

      expect(service.isAbandoned("game-1", "player-b")).toBe(false);
    });

    it("returns false for the same player in a different game", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");
      provider.fireAll();

      expect(service.isAbandoned("game-2", "player-a")).toBe(false);
    });
  });

  describe("unregisterGame", () => {
    it("cancels all timers for the specified game", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");
      service.startGracePeriod("game-1", "player-b");

      service.unregisterGame("game-1");

      expect(provider.pendingCount).toBe(0);
    });

    it("clears abandoned flags for the specified game", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");
      provider.fireAll(); // marks player-a abandoned

      service.unregisterGame("game-1");

      expect(service.isAbandoned("game-1", "player-a")).toBe(false);
    });

    it("does not affect timers for other games", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");
      service.startGracePeriod("game-2", "player-b");

      service.unregisterGame("game-1");

      expect(provider.pendingCount).toBe(1);
    });

    it("does not affect abandoned flags for other games", () => {
      const { provider, service } = makeService();
      service.startGracePeriod("game-1", "player-a");
      service.startGracePeriod("game-2", "player-b");
      provider.fireAll(); // both expire

      service.unregisterGame("game-1");

      expect(service.isAbandoned("game-2", "player-b")).toBe(true);
    });

    it("is a no-op for a game with no registered players", () => {
      const { service } = makeService();
      expect(() => service.unregisterGame("unknown-game")).not.toThrow();
    });
  });
});
