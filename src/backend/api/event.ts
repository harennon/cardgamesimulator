import { Handler } from "@/api/handler";
import { BadRequestError, InternalServerError } from "@/util/errors";
import { Request, Response } from "@/util/types";
import { SerializableGame } from "@shared/model";

export class EventHandler extends Handler {
    public static INSTANCE: EventHandler = new EventHandler();

    private _connMap: Map<string, Response[]> = new Map();

    private constructor() { super(); }

    public override async get(req: Request, res: Response) {
        if (!req.accountId) {
            throw new BadRequestError();
        }

        // Set headers to keep the connection alive and tell the client we're sending event-stream data
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
    

        // add connection to map for publishers to retrieve
        const currentResponses = this._connMap.get(req.accountId);
        this._connMap.set(req.accountId, currentResponses ? [res, ...currentResponses] : [res]);

        console.log(`write = ${res.write(`data: initial connection\n\n`)}`);

        const intervalId = setInterval(() => {
            console.log(`Writing ping to event for accountId: ${req.accountId}`);
            console.log(`write = ${res.write(`data: keep connection alive\n\n`)}`);
        }, 60*1000)

        req.on("close", () => {
            clearInterval(intervalId);
            res.end();
            if (!req.accountId) {
                // fast fail with cleanup
                return;
            }

            // remove connection from map
            let currentResponses = this._connMap.get(req.accountId);
            currentResponses = currentResponses?.filter((response) => response === res);
            if (currentResponses) {
                this._connMap.set(req.accountId, currentResponses);
            } else {
                this._connMap.delete(req.accountId);
            }
        })
    }

    /**
     * Emit SSE to all responses correlated with accountId
     * @param accountId specified accountId to emit events for
     * @param eventData data to emit
     */
    public sendEvent(accountId: string, eventData: SerializableGame) {
        console.log("SendEvents called for account: " + accountId);
        const responses = this._connMap.get(accountId);
        if (!responses || responses.length === 0) {
            console.error(`No event listeners for accountId ${accountId}`);
            throw new InternalServerError();
        }
        responses.forEach((res: Response) => {
            console.log(`Writing game state to ${accountId}`)
            res.write(`event: game-state\n`);
            res.write(`data: ${JSON.stringify(eventData)}\n\n`);
        });
    }
}