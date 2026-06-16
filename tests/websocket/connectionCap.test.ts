import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TypedServer } from "../../src/backend/websocket/socketServer.js";

let createSocketServer: typeof import("../../src/backend/websocket/socketServer.js").createSocketServer;
let getConnectionMetrics: typeof import("../../src/backend/websocket/socketServer.js").getConnectionMetrics;

let clientsCount = 0;
const registeredMiddlewares: ((
  socket: unknown,
  next: (err?: Error) => void,
) => void)[] = [];

vi.mock("socket.io", () => {
  return {
    Server: class MockServer {
      engine = {
        get clientsCount() {
          return clientsCount;
        },
      };
      use(mw: (socket: unknown, next: (err?: Error) => void) => void) {
        registeredMiddlewares.push(mw);
      }
    },
    Socket: class {},
  };
});

beforeEach(async () => {
  vi.resetModules();
  clientsCount = 0;
  registeredMiddlewares.length = 0;
  const mod = await import("../../src/backend/websocket/socketServer.js");
  createSocketServer = mod.createSocketServer;
  getConnectionMetrics = mod.getConnectionMetrics;
});

describe("connection cap middleware", () => {
  it("allows connections below cap", () => {
    clientsCount = 50;
    const fakeHttpServer = {} as never;
    createSocketServer(fakeHttpServer);

    const capMiddleware = registeredMiddlewares[0]!;
    const errors: Error[] = [];
    capMiddleware({}, (err?: Error) => {
      if (err) errors.push(err);
    });

    expect(errors).toHaveLength(0);
  });

  it("rejects connections at cap with SERVER_FULL", () => {
    clientsCount = 1000;
    const fakeHttpServer = {} as never;
    createSocketServer(fakeHttpServer);

    const capMiddleware = registeredMiddlewares[0]!;
    const errors: Error[] = [];
    capMiddleware({}, (err?: Error) => {
      if (err) errors.push(err);
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("SERVER_FULL");
  });

  it("rejects connections above cap", () => {
    clientsCount = 1500;
    const fakeHttpServer = {} as never;
    createSocketServer(fakeHttpServer);

    const capMiddleware = registeredMiddlewares[0]!;
    const errors: Error[] = [];
    capMiddleware({}, (err?: Error) => {
      if (err) errors.push(err);
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("SERVER_FULL");
  });

  it("increments rejection counter on each rejection", () => {
    clientsCount = 1000;
    const fakeHttpServer = {} as never;
    const io = createSocketServer(fakeHttpServer);

    const capMiddleware = registeredMiddlewares[0]!;
    capMiddleware({}, () => {});
    capMiddleware({}, () => {});

    const metrics = getConnectionMetrics(io);
    expect(metrics.rejections).toBe(2);
    expect(metrics.current).toBe(1000);
    expect(metrics.max).toBe(1000);
  });

  it("reports zero rejections when under cap", () => {
    clientsCount = 10;
    const fakeHttpServer = {} as never;
    const io = createSocketServer(fakeHttpServer);

    const capMiddleware = registeredMiddlewares[0]!;
    capMiddleware({}, () => {});

    const metrics = getConnectionMetrics(io);
    expect(metrics.rejections).toBe(0);
    expect(metrics.current).toBe(10);
  });
});
