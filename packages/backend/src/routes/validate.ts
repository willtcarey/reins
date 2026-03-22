/**
 * Request Validation Helpers
 *
 * Thin wrappers around TypeBox runtime validation that throw HttpError(400)
 * on malformed request bodies or URL params.
 */

import type { TSchema, Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { HttpError } from "../errors.js";

/**
 * Parse and validate a JSON request body against a TypeBox schema.
 * Returns the parsed (and coerced) value, or throws HttpError(400).
 */
export async function parseBody<T extends TSchema>(
  schema: T,
  req: Request,
): Promise<Static<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON in request body");
  }
  try {
    return Value.Parse(schema, raw);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Request body validation failed";
    throw new HttpError(400, `Invalid request body: ${message}`);
  }
}

/**
 * Extract an integer URL param by name. Throws HttpError(400) if missing or
 * not a valid integer string.
 */
export function parseIntParam(
  params: Record<string, string>,
  name: string,
): number {
  const raw = params[name];
  if (raw === undefined || raw === "") {
    throw new HttpError(400, `Missing required URL parameter: ${name}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new HttpError(400, `URL parameter '${name}' must be an integer, got: ${raw}`);
  }
  return n;
}
