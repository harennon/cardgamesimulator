import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { Handler } from './api/handler';
import { EchoHandler } from './api/echo';

export class Server {
    private readonly app: Express;
    private readonly server: https.Server | http.Server;

    constructor() {
        this.app = express();
        // add middleware
        this.app.use(express.json());
        this.app.use(helmet())

        // register api handlers
        new Map([
            ["/", new EchoHandler()],
            ["/echo", new EchoHandler()]
        ]).forEach((handler: Handler, path: string) => {
            this.app.use(path, handler.router);
        });

        // initialize server
        this.server = this.createServer(this.app);
    }

    public start() {
        // start server
        const port = process.env.PORT || 8000;
        console.log(`Listening on port ${port}`);
        this.server.listen(port);
    }

    public close(force: boolean, callback: (force: boolean) => void) {
        // callback function to close dependencies
        callback(force);
        this.server.close();
    }

    private createServer(app: Express): https.Server | http.Server {
        if (process.env.KEY_PATH && process.env.CERT_PATH) {
            const options = {
                key: fs.readFileSync(process.env.KEY_PATH),
                cert: fs.readFileSync(process.env.CERT_PATH)
            }
            return https.createServer(options, app);
        } else {
            console.log("Please set up valid certificates to create an HTTPS server.")
            return http.createServer(app);
        }
    }
}