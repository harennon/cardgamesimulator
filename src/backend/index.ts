import "@/env";

import { Server } from "@/server";
import { logger } from "@/util/logger";

const onCloseSignal = (server: Server, force: boolean) => {
  logger.info("Close signal received, shutting down");
  server.close(force, (force: boolean) => {
    logger.info({ force }, "Closing dependencies");
  });

  if (force) {
    setTimeout(() => process.exit(1), 10000).unref(); // Force shutdown after 10s
  }
};

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled rejection");
});

try {
  const server = new Server();
  server.start();
  process.on("SIGTERM", () => onCloseSignal(server, false));
  process.on("SIGINT", () => onCloseSignal(server, true));
} catch (err) {
  logger.error({ err }, "Encountered error while starting server");
}
