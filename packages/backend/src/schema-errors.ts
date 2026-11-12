/**
 * Why a value does not match a TypeBox schema, for messages that name the field: the host's checks of extensions'
 * HTTP input and of scripts' arguments.
 */

import type { TSchema } from "@sinclair/typebox";
import { Value, ValueErrorType, type ValueError } from "@sinclair/typebox/value";

/** The first reason `value` does not match `schema`, or null. Within a union, the reason is the member's it comes
 * closest to (the one with the fewest errors): TypeBox's own says only "Expected union value". */
export function firstSchemaError(schema: TSchema, value: unknown): ValueError | null {
  const first = Value.Errors(schema, value).First();
  return first ? closestMemberError(first) : null;
}

function closestMemberError(error: ValueError): ValueError {
  if (error.type !== ValueErrorType.Union) return error;
  const members = error.errors.map(member => [...member]).filter(errors => errors.length > 0);
  const closest = members.toSorted((a, b) => a.length - b.length)[0];
  return closest ? closestMemberError(closest[0]!) : error;
}
