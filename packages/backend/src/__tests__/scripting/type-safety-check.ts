/**
 * Compile-time type safety verification.
 *
 * This file is NOT a runtime test — it exists only to verify that
 * defineFunction catches type mismatches at compile time. Each
 * @ts-expect-error comment marks a line that MUST produce a type error.
 * If the error disappears (i.e. the bad code compiles), tsc will fail
 * on the unused @ts-expect-error directive.
 */

import { Type } from "@sinclair/typebox";
import { defineFunction } from "../../scripting/api-registry.js";

// GOOD: execute return matches schema
defineFunction({
  name: "test.good",
  description: "test",
  parameters: Type.Object({ id: Type.Number() }),
  returns: Type.Number(),
  tags: [],
  execute: (params, _ctx) => params.id,
});

// BAD: execute returns string, schema says number
defineFunction({
  name: "test.badReturn",
  description: "test",
  parameters: Type.Object({ id: Type.Number() }),
  returns: Type.Number(),
  tags: [],
  // @ts-expect-error — return type 'string' is not assignable to 'number'
  execute: (_params, _ctx) => "not a number",
});

// GOOD: params are typed — id is number, name is string
defineFunction({
  name: "test.typedParams",
  description: "test",
  parameters: Type.Object({ id: Type.Number(), name: Type.String() }),
  returns: Type.String(),
  tags: [],
  execute: (params, _ctx) => {
    const result: string = `${params.id}-${params.name}`;
    return result;
  },
});
