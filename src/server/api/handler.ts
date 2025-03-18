import express, { type Router, type Request, type Response } from 'express';

export abstract class Handler {
    public readonly router: Router = express.Router();

    constructor() {
        this.router.get("/", this.get);
        this.router.put("/", this.put);
        this.router.post("/", this.post);
    }

    public get(request: Request, response: Response) {
        response.status(404).send("InvalidRequest");
     }
    public put(request: Request, response: Response) {
        response.status(404).send("InvalidRequest");
     }
    public post(request: Request, response: Response) {
        response.status(404).send("InvalidRequest");
    }
} 