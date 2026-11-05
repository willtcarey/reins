/** The images of a tool's result, which every tool renderer shows the same way (`<tool-result-images>`). */

import type { ToolBlockData } from "../chat-state.js";
import { isImageAttachmentBlock, isInlineImageBlock, type ChatImageBlock } from "../chat-content.js";

/** Inline blocks while live, attachment references once stored; in order. */
export function toolResultImages(block: ToolBlockData): ChatImageBlock[] {
  return block.result?.content
    ?.filter((c): c is ChatImageBlock => isInlineImageBlock(c) || isImageAttachmentBlock(c)) ?? [];
}
