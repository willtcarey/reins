/**
 * Shared mappings between SDK format and our normalized runtime format.
 *
 * Defines the canonical maps once; both directions (normalize and translate)
 * are derived from the same data to stay in sync.
 */

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

/** SDK tool name → normalized name (e.g. "Read" → "read") */
const SDK_TO_NORMALIZED_TOOL_NAMES: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Bash: "bash",
};

/** Normalized name → SDK tool name (e.g. "read" → "Read") */
const NORMALIZED_TO_SDK_TOOL_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(SDK_TO_NORMALIZED_TOOL_NAMES).map(([k, v]) => [v, k]),
);

export const MCP_CUSTOM_TOOL_PREFIX = "mcp__custom-tools__";

/** Custom MCP tool names (without prefix) */
export const CUSTOM_TOOL_NAMES = new Set(["create_task", "delegate", "search", "execute"]);

/** SDK tool name → normalized name, stripping MCP prefix for custom tools. */
export function normalizeToolName(sdkName: string): string {
  if (sdkName.startsWith(MCP_CUSTOM_TOOL_PREFIX)) {
    return sdkName.slice(MCP_CUSTOM_TOOL_PREFIX.length);
  }
  return SDK_TO_NORMALIZED_TOOL_NAMES[sdkName] ?? sdkName;
}

/** Normalized name → SDK tool name, adding MCP prefix for custom tools. */
export function toSDKToolName(normalizedName: string): string {
  if (NORMALIZED_TO_SDK_TOOL_NAMES[normalizedName]) return NORMALIZED_TO_SDK_TOOL_NAMES[normalizedName];
  if (CUSTOM_TOOL_NAMES.has(normalizedName)) return MCP_CUSTOM_TOOL_PREFIX + normalizedName;
  return normalizedName;
}

// ---------------------------------------------------------------------------
// Tool args
// ---------------------------------------------------------------------------

/** SDK arg name → normalized arg name, keyed by normalized tool name. */
const TOOL_ARG_RENAMES: Record<string, Record<string, string>> = {
  read: { file_path: "path" },
  write: { file_path: "path" },
  edit: { file_path: "path", old_string: "oldText", new_string: "newText" },
};

/** Normalized arg name → SDK arg name, keyed by normalized tool name. */
const TOOL_ARG_RENAMES_REVERSE: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(TOOL_ARG_RENAMES).map(([tool, renames]) => [
    tool,
    Object.fromEntries(Object.entries(renames).map(([k, v]) => [v, k])),
  ]),
);

function renameKeys(args: Record<string, unknown>, renames: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[renames[key] ?? key] = value;
  }
  return out;
}

/**
 * SDK arg names → normalized arg names.
 * Accepts the **normalized** tool name (e.g. "edit", not "Edit").
 */
export function normalizeToolArgs(normalizedToolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const renames = TOOL_ARG_RENAMES[normalizedToolName];
  if (!renames) return args;
  return renameKeys(args, renames);
}

/**
 * Normalized arg names → SDK arg names.
 * Accepts the **normalized** tool name (e.g. "edit", not "Edit").
 */
export function toSDKToolArgs(normalizedToolName: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!args) return {};
  const renames = TOOL_ARG_RENAMES_REVERSE[normalizedToolName];
  if (!renames) return args;
  return renameKeys(args, renames);
}

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

/** SDK stop reason → normalized (e.g. "tool_use" → "toolUse") */
const SDK_TO_NORMALIZED_STOP_REASONS: Record<string, string> = {
  tool_use: "toolUse",
  end_turn: "endTurn",
};

/** Normalized → SDK (e.g. "toolUse" → "tool_use") */
const NORMALIZED_TO_SDK_STOP_REASONS: Record<string, string> = Object.fromEntries(
  Object.entries(SDK_TO_NORMALIZED_STOP_REASONS).map(([k, v]) => [v, k]),
);

export function normalizeStopReason(sdkReason: string | null | undefined): string | undefined {
  if (!sdkReason) return undefined;
  return SDK_TO_NORMALIZED_STOP_REASONS[sdkReason] ?? sdkReason;
}

export function toSDKStopReason(normalizedReason: string | undefined): string | undefined {
  if (!normalizedReason) return undefined;
  return NORMALIZED_TO_SDK_STOP_REASONS[normalizedReason] ?? normalizedReason;
}
