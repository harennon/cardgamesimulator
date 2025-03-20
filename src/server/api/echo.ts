import { Handler } from './handler'
import { type Request, type Response } from 'express';

export class EchoHandler extends Handler {
    public override put(request: Request, response: Response) {
        response.status(200).json(request.body)
    }

    public override post(request: Request, response: Response) {
        response.status(200).json(request.body)
    }
}