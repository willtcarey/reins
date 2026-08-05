import type { AgentMessage } from "./chat-state.js";
import { textFromClientContent } from "./chat-content.js";

/** Return the raw Markdown represented by an actionable transcript message. */
export function messageMarkdown(message: AgentMessage): string | null {
  if (message.role === "user") {
    const text = typeof message.content === "string"
      ? message.content
      : textFromClientContent(message.content);
    return text.length > 0 ? text : null;
  }

  if (message.role === "assistant") {
    const text = message.content
      .flatMap((block) => block.type === "text" && block.text.length > 0 ? [block.text] : [])
      .join("\n\n");
    return text.length > 0 ? text : null;
  }

  return null;
}
