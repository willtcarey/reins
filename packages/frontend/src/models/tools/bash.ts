/**
 * Pure logic helpers for Bash tool blocks (tested without DOM).
 */

import type { ToolBlockData } from "../chat-state.js";

/** Extract the full command string from a Bash tool block. */
export function getBashCommand(block: ToolBlockData): string {
  return block.args?.command ?? "";
}

/** How many lines of a command show before it is expanded. */
export const COMMAND_LINES = 10;

/**
 * The part of a command its block shows, and how many lines are left out before and after it. Models write long
 * scripts into a command (a heredoc of Python): while it is written its newest lines show, as a write's do, and once
 * written its first ones, until it is expanded.
 */
export function shownCommand(command: string, { writing, expanded }: { writing: boolean; expanded: boolean }): { text: string; before: number; after: number } {
  const lines = command.split("\n");
  if (expanded || lines.length <= COMMAND_LINES) return { text: command, before: 0, after: 0 };
  const left = lines.length - COMMAND_LINES;
  return writing
    ? { text: lines.slice(left).join("\n"), before: left, after: 0 }
    : { text: lines.slice(0, COMMAND_LINES).join("\n"), before: 0, after: left };
}

/** Extract the first line of output text for a compact preview. */
export function getBashPreview(block: ToolBlockData, maxLen = 120): string {
  const texts = block.result?.content
    ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text) ?? [];

  const joined = texts.join("\n").trim();
  if (!joined) return "";

  const firstLine = joined.split("\n")[0];
  if (firstLine.length > maxLen) {
    return firstLine.slice(0, maxLen - 1) + "…";
  }
  return firstLine;
}

/** Get the full output text from a Bash tool block. */
export function getBashOutput(block: ToolBlockData): string {
  return block.result?.content
    ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
}

/** Get exit/error info from a Bash tool block. */
export function getBashExitInfo(block: ToolBlockData): { isError: boolean; label: string } {
  if (block.status === "running") {
    return { isError: false, label: "running" };
  }
  if (block.isError) {
    return { isError: true, label: "error" };
  }
  return { isError: false, label: "ok" };
}
