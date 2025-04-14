import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';

import { Handler } from '@/api/handler';
import { EchoHandler } from '@/api/echo';
import { ServeAppHandler } from '@/api/serveApp';
import { GenerateNonceHandler } from '@/api/auth/getNonce';
import { CreateAccountHandler } from '@/api/auth/createAccount';
import { GetAuthTokenHandler } from '@/api/auth/getAuthToken';
import { PostgresDB } from '@/database/postgres';
import { errorHandler } from '@/middleware/errorHandler';
import { authNHandler } from '@/middleware/authNHandler';
import { CreateGameHandler } from '@/api/game/createGame';
import { JoinGameHandler } from '@/api/game/joinGame';
import { EventHandler } from '@/api/event';
import { GetGameStateHandler } from '@/api/game/getGameState';
import { BatchGetUsernameHandler } from '@/api/auth/batchGetUsername';

export class Server {
    private readonly app: Express;
    private readonly server: https.Server | http.Server;

    constructor() {
        this.app = express();
        // add middleware
        this.app.use(express.json());
        this.app.use(helmet());
        this.app.use(cookieParser())
        this.app.use(cors({origin: 'http://frontend:80'}));
        this.app.use(morgan(':method :url', {immediate: true}));
        this.app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

        // register api handlers
        new Map<string, Handler>([
            ["/", ServeAppHandler.INSTANCE],
            ["/echo", EchoHandler.INSTANCE],
            ["/auth/getNonce", GenerateNonceHandler.INSTANCE],
            ["/auth/createAccount", CreateAccountHandler.INSTANCE],
            ["/auth/getAuthToken", GetAuthTokenHandler.INSTANCE],
            ["/auth/batchGetUsername", BatchGetUsernameHandler.INSTANCE],
        ]).forEach((handler: Handler, path: string) => {
            this.app.use(path, handler.router);
        });
        new Map<string, Handler>([
            ["/authNedEcho", EchoHandler.INSTANCE],
            ["/event", EventHandler.INSTANCE],
            ["/createGame", CreateGameHandler.INSTANCE],
            ["/joinGame", JoinGameHandler.INSTANCE],
            ["/getGameState", GetGameStateHandler.INSTANCE],
        ]).forEach((handler: Handler, path: string) => {
            this.app.use(path, authNHandler, handler.router);
        });
        // register error middleware
        this.app.use(errorHandler);

        // initialize server
        this.server = this.createServer(this.app);
    }

    public async start() {
        // initialize database
        await PostgresDB.INSTANCE.initialize();
        
        // start server
        const port = process.env.BACKEND_PORT || 3000;
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