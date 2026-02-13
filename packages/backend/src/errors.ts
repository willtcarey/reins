/**
 * HTTP Error Helpers
 *
 * Throw HttpError from any route handler — the router catches it
 * and returns the appropriate JSON error response automatically.
 */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Throw a 400 Bad Request.
 */
export function badRequest(message: string): never {
  throw new HttpError(400, message);
}

/**
 * Throw a 404 Not Found.
 */
export function notFound(message: string): never {
  throw new HttpError(404, message);
}

/**
 * Throw a 409 Conflict.
 */
export function conflict(message: string): never {
  throw new HttpError(409, message);
}
