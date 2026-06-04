/**
 * Tool Renderer Registry
 *
 * Maps tool names to their specific renderers.
 * Falls back to the generic renderer for unknown tools.
 */

import type { ToolRenderer } from "./types.js";
import { genericRenderer } from "./generic.js";
import { readRenderer } from "./read.js";
import { bashRenderer } from "./bash.js";
import { editRenderer } from "./edit.js";
import { writeRenderer } from "./write.js";
import { createTaskRenderer } from "./create-task.js";
import { delegateRenderer } from "./delegate.js";
import { executeRenderer } from "./execute.js";
import { searchRenderer } from "./search.js";

const toolRenderers: Record<string, ToolRenderer> = {
  read: readRenderer,
  bash: bashRenderer,
  edit: editRenderer,
  write: writeRenderer,
  create_task: createTaskRenderer,
  delegate: delegateRenderer,
  execute: executeRenderer,
  search: searchRenderer,
};

/** Get the renderer for a tool by name, falling back to the generic renderer. */
export function getToolRenderer(name: string): ToolRenderer {
  return toolRenderers[name] ?? genericRenderer;
}
