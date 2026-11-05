/**
 * Compile-time type safety verification.
 *
 * This file is NOT a runtime test — it exists only to verify that a method's declaration types its
 * implementation (`sdkMethod`) and its callers (`bind`) at compile time. Each @ts-expect-error comment marks a
 * line that MUST produce a type error. If the error disappears (i.e. the bad code compiles), tsc will fail on
 * the unused @ts-expect-error directive.
 */

import { Type } from "@sinclair/typebox";
import { bind, sdkMethod, type CallContext } from "../../sdk-host/declaration.js";

// GOOD: run's arguments are the params' types, its result the return schema's.
const good = sdkMethod({
  description: "test",
  params: [{ name: "id", schema: Type.Number() }, { name: "name", schema: Type.String(), optional: true }],
  returns: Type.String(),
  tags: [],
  run: async (_context, id, name) => `${id.toFixed()}-${name ?? ""}`,
});

// @ts-expect-error — run's result 'string' is not the return schema's 'number', and no toScript makes it one
sdkMethod({
  description: "test",
  params: [{ name: "id", schema: Type.Number() }],
  returns: Type.Number(),
  tags: [],
  run: async () => "not a number",
});

// GOOD: a script gets toScript's form of run's result, which the return schema documents.
sdkMethod({
  description: "test",
  params: [{ name: "id", schema: Type.Number() }],
  returns: Type.String(),
  tags: [],
  run: async (_context, id) => ({ id }),
  toScript: result => String(result.id),
});

sdkMethod({
  description: "test",
  params: [{ name: "id", schema: Type.Number() }],
  returns: Type.Number(),
  tags: [],
  // @ts-expect-error — id is a number, not a string
  run: async (_context, id: string) => id.length,
});

declare const context: () => CallContext;
const bound = bind({ good }, context);
void bound.good(1);
void bound.good(1, "x");
// @ts-expect-error — the first argument is required
void bound.good();
// @ts-expect-error — the optional argument is a string
void bound.good(1, 2);
