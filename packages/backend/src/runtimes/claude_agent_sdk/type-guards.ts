/** Type guard: narrows `unknown` to `Record<string, unknown>`. */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

/** Coerce `unknown` to `Record<string, unknown>`, falling back to `{}`. */
export function toRecord(x: unknown): Record<string, unknown> {
  return isRecord(x) ? x : {};
}
