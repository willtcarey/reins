/**
 * Shell command parser for syntax highlighting.
 *
 * Splits a command string into segments: command names, arguments, and
 * pipe/chain operators. Intentionally simple — not a real shell parser.
 * Handles the common patterns agents emit (pipes, &&, ||, ;) with basic
 * quote awareness.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandSegment =
  | { type: "command"; text: string }
  | { type: "args"; text: string }
  | { type: "operator"; text: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a shell command string into highlighted segments.
 *
 * Command names are tagged as "command", flags/paths/values as "args",
 * and pipe/chain operators (|, &&, ||, ;) as "operator".
 */
export function parseCommandSegments(command: string): CommandSegment[] {
  if (!command.trim()) return [{ type: "args", text: command || "…" }];

  const segments: CommandSegment[] = [];
  const parts = splitOnOperators(command);

  for (const part of parts) {
    if (part.isOperator) {
      segments.push({ type: "operator", text: part.text });
    } else {
      const trimmed = part.text.trimStart();
      const leadingWs = part.text.slice(0, part.text.length - trimmed.length);
      const { prefix, cmd, rest } = extractCommand(trimmed);

      if (leadingWs) segments.push({ type: "args", text: leadingWs });
      if (prefix) segments.push({ type: "args", text: prefix });
      if (cmd) segments.push({ type: "command", text: cmd });
      if (rest) segments.push({ type: "args", text: rest });
    }
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface SplitPart {
  text: string;
  isOperator: boolean;
}

/**
 * Split input on shell operators (|, &&, ||, ;) while respecting quotes.
 * Returns alternating command fragments and operator tokens.
 */
function splitOnOperators(input: string): SplitPart[] {
  const parts: SplitPart[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  const flush = () => {
    if (current) {
      parts.push({ text: current, isOperator: false });
      current = "";
    }
  };

  while (i < input.length) {
    const ch = input[i];

    // Backslash escape — next char is literal
    if (ch === "\\" && i + 1 < input.length) {
      current += ch + input[i + 1];
      i += 2;
      continue;
    }

    // Track quote state
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }
    if (inSingle || inDouble) { current += ch; i++; continue; }

    // Two-char operators first
    if (ch === "&" && input[i + 1] === "&") {
      flush(); parts.push({ text: "&&", isOperator: true }); i += 2; continue;
    }
    if (ch === "|" && input[i + 1] === "|") {
      flush(); parts.push({ text: "||", isOperator: true }); i += 2; continue;
    }
    // Single-char operators
    if (ch === "|") {
      flush(); parts.push({ text: "|", isOperator: true }); i++; continue;
    }
    if (ch === ";") {
      flush(); parts.push({ text: ";", isOperator: true }); i++; continue;
    }

    current += ch;
    i++;
  }
  flush();
  return parts;
}

/** Words that prefix a command but aren't the "real" command. */
const PREFIX_WORDS = new Set(["sudo", "env", "nohup", "time", "nice", "exec"]);

/**
 * Extract the first "command word" from a trimmed command fragment.
 * Skips leading env-var assignments (FOO=bar) and prefix words (sudo, env, …).
 */
function extractCommand(text: string): { prefix: string; cmd: string; rest: string } {
  let remaining = text;
  let prefix = "";

  // Skip env var assignments like FOO=bar at the start
  while (true) {
    const envMatch = remaining.match(/^([A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)/);
    if (envMatch) {
      prefix += envMatch[1];
      remaining = remaining.slice(envMatch[1].length);
    } else {
      break;
    }
  }

  // Skip sudo/env/nohup-style prefixes
  while (true) {
    const match = remaining.match(/^(\S+)(\s+)(.*)/s);
    if (match && PREFIX_WORDS.has(match[1])) {
      prefix += match[1] + match[2];
      remaining = match[3];
    } else {
      break;
    }
  }

  // First word is the command
  const cmdMatch = remaining.match(/^(\S+)(.*)/s);
  if (!cmdMatch) {
    return { prefix, cmd: "", rest: remaining };
  }

  return { prefix, cmd: cmdMatch[1], rest: cmdMatch[2] };
}
