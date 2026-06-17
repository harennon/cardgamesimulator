export interface ErrorWithStatus extends Error {
  status: number;
  message: string;
}

export function instanceOfErrorWithStatus(
  object: unknown,
): object is ErrorWithStatus {
  return (
    typeof object === "object" &&
    object !== null &&
    "status" in object &&
    "message" in object
  );
}

export class UnauthorizedError extends Error implements ErrorWithStatus {
  public readonly status: number = 401;

  public static readonly message: string =
    "Unauthorized Error: No valid credentials found.";

  constructor() {
    super(UnauthorizedError.message);
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

export class AccessDeniedError extends Error implements ErrorWithStatus {
  public readonly status: number = 403;

  public static readonly message: string =
    "Access Denied Error: You do not have access.";

  constructor() {
    super(AccessDeniedError.message);
    Object.setPrototypeOf(this, AccessDeniedError.prototype);
  }
}

export class BadRequestError extends Error implements ErrorWithStatus {
  public readonly status: number = 400;

  public static readonly message: string = "Bad Request";

  constructor() {
    super(BadRequestError.message);
    Object.setPrototypeOf(this, BadRequestError.prototype);
  }
}

export class AlreadyExistsError extends Error implements ErrorWithStatus {
  public readonly status: number = 409;

  public static readonly message: string = "Already Exists";

  constructor() {
    super(AlreadyExistsError.message);
    Object.setPrototypeOf(this, AlreadyExistsError.prototype);
  }
}

export class InternalServerError extends Error implements ErrorWithStatus {
  public readonly status: number = 500;

  public static readonly message: string = "An unknown error has occurred.";

  constructor() {
    super(InternalServerError.message);
    Object.setPrototypeOf(this, InternalServerError.prototype);
  }
}

export class NotFoundError extends Error implements ErrorWithStatus {
  public readonly status: number = 404;

  public static readonly message: string = "Not Found";

  constructor() {
    super(NotFoundError.message);
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

export class OptimisticLockError extends Error implements ErrorWithStatus {
  public readonly status: number = 409;

  constructor(gameId: string, expectedVersion: number) {
    super(
      `Optimistic lock failed for game ${gameId} at version ${expectedVersion}`,
    );
    this.name = "OptimisticLockError";
    Object.setPrototypeOf(this, OptimisticLockError.prototype);
  }
}
