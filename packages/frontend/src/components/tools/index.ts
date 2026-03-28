/**
 * Tool Renderer Registry
 *
 * Maps tool names to their specific renderers.
 * Falls back to the generic renderer for unknown tools.
 */

export type { ToolRenderer } from "./types.js";
export { getToolSummary } from "../../models/tools/generic.js";
export { genericRenderer } from "./generic.js";
export { readRenderer } from "./read.js";
export { bashRenderer } from "./bash.js";
export { editRenderer } from "./edit.js";
export { writeRenderer } from "./write.js";
export { createTaskRenderer } from "./create-task.js";
export { delegateRenderer } from "./delegate.js";
export { executeRenderer } from "./execute.js";
export { searchRenderer } from "./search.js";

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
