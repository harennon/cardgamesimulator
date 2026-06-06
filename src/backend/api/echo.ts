import { type Request, type Response } from "@/util/types";
import { Handler } from "@/api/handler";
import { EchoRequest, EchoResponse } from "@shared/model";

export class EchoHandler extends Handler {
  public static INSTANCE: EchoHandler = new EchoHandler();
  private constructor() {
    super();
  }

  public override async put(
    request: Request<EchoRequest>,
    response: Response<EchoResponse>,
  ) {
    response.status(200).json(request.body);
  }

  public override async post(
    request: Request<EchoRequest>,
    response: Response<EchoResponse>,
  ) {
    response.status(200).json(request.body);
  }
}
