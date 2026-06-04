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
    const detail = formatValidationError(err);
    throw new HttpError(400, `Invalid request body: ${detail}`);
  }
}

/**
 * Parse multipart form data or throw a 400 with a consistent message.
 */
export async function parseFormData(req: Request): Promise<FormData> {
  try {
    return await req.formData();
  } catch {
    throw new HttpError(400, "Expected multipart/form-data");
  }
}

/**
 * Extract a required file list from multipart form data.
 */
export function parseFormFiles(
  form: FormData,
  field: string,
  options: { emptyMessage?: string } = {},
): File[] {
  const entries = form.getAll(field);
  if (entries.length === 0) {
    throw new HttpError(400, options.emptyMessage ?? `Missing required file field: ${field}`);
  }

  return entries.map((entry) => {
    if (!(entry instanceof File)) {
      throw new HttpError(400, `Form field '${field}' must contain files`);
    }
    return entry;
  });
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

/** Format a TypeBox AssertError into a human-readable message including field paths. */
function formatValidationError(err: unknown): string {
  // TypeBox AssertError has an `error` property with path and message fields.
  // Value.Errors() returns the same path/message shape directly.
  const first: unknown = err instanceof Object && "error" in err ? err.error : err;
  if (first && typeof first === "object" && "path" in first && "message" in first) {
    const path = typeof first.path === "string" ? first.path : "";
    const message = typeof first.message === "string" ? first.message : "Validation failed";
    const field = path.replace(/^\//, "") || "(root)";
    return `${field}: ${message}`;
  }
  return err instanceof Error ? err.message : "Validation failed";
}
