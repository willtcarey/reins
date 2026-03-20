import type { TemplateResult } from "lit";
import type { ToolBlockData } from "../chat-state.js";

export interface ToolRenderer {
  renderRunning(block: ToolBlockData): TemplateResult;
  renderDone(block: ToolBlockData, expanded: boolean, onToggle: () => void): TemplateResult;
}
