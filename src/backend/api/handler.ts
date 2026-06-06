import express, { type Router } from "express";

import { type Request, type Response } from "@/util/types";
import { BadRequestError } from "@/util/errors";

export abstract class Handler {
  public readonly router: Router = express.Router();

  protected constructor() {
    this.router.get("/", async (req, res) => this.get(req, res));
    this.router.put("/", async (req, res) => this.put(req, res));
    this.router.post("/", async (req, res) => this.post(req, res));
  }

  public async get(_request: Request, _response: Response) {
    throw new BadRequestError();
  }
  public async put(_request: Request, _response: Response) {
    throw new BadRequestError();
  }
  public async post(_request: Request, _response: Response) {
    throw new BadRequestError();
  }
}
