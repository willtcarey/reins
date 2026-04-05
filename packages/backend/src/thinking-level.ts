import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

export const THINKING_LEVEL_VALUES = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const ThinkingLevelSchema = Type.Union(
  THINKING_LEVEL_VALUES.map((level) => Type.Literal(level)),
  { description: `Thinking level (${THINKING_LEVEL_VALUES.join(", ")})` },
);

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVEL_VALUES.some((candidate) => candidate === value);
}

export function parseThinkingLevel(value: string): ThinkingLevel {
  if (isThinkingLevel(value)) return value;

  throw new Error(
    `Invalid thinking level '${value}'. Valid levels: ${THINKING_LEVEL_VALUES.join(", ")}`,
  );
}
