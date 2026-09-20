import type { TemplateResult } from "lit";
import type { ToolBlockData } from "../../models/chat-state.js";

/**
 * Interface for tool-specific renderers.
 *
 * Each renderer has a single `render` method that receives the full
 * ToolBlockData (including status) and a narrow workspace context. The renderer is responsible for
 * deciding how to present running vs done states — typically by passing
 * primitive props to a Lit component that owns its own expansion state
 * across the running→done transition.
 */
export interface ToolRenderContext {
  projectId: number | null;
  projectDir: string | null;
}

export interface ToolRenderer {
  render(block: ToolBlockData, context: ToolRenderContext): TemplateResult;
}
