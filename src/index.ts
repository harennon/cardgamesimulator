import * as dotenv from 'dotenv';
import { Server } from './server/server';

const onCloseSignal = (server: Server, force: boolean) => {
	console.log("Close signal received, shutting down");
	server.close(force, (force: boolean) => {
        console.log(`Closing dependencies with force = ${force}`);
    });

    if (force) {
        setTimeout(() => process.exit(1), 10000).unref(); // Force shutdown after 10s
    }
}

try {
    dotenv.config();
    const server = new Server();
    server.start();
    process.on("SIGTERM", () => onCloseSignal(server, false))
    process.on("SIGINT", () => onCloseSignal(server, true))
    process.on("SIGKILL", () => onCloseSignal(server, true))
} catch (err) {
    console.error("Encountered error while starting server");
    console.error(err);
}

