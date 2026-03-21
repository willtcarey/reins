import type { TemplateResult } from "lit";
import type { ToolBlockData } from "../chat-state.js";

export interface ToolRenderer {
  renderRunning(block: ToolBlockData): TemplateResult;
  renderDone(block: ToolBlockData): TemplateResult;
}

/** Inline image data from a tool result. */
export interface ToolResultImage {
  data: string;
  mimeType: string;
}
