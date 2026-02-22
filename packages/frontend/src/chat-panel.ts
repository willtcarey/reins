/**
 * Chat Panel
 *
 * Lit web component that renders the conversation between the user and the
 * agent, handles streaming text updates, tool call display, and user input.
 * Uses light DOM so Tailwind classes work directly.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import type { AppClient, SessionData } from "./ws-client.js";

// Configure marked for safe defaults
marked.setOptions({
  breaks: true,
  gfm: true,
});

// ---- Types (matching pi-ai / pi-agent-core shapes) -------------------------

interface TextContent {
  type: "text";
  text: string;
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  timestamp: number;
}

interface UserMessage {
  role: "user";
  content: string | (TextContent | { type: "image"; data: string; mimeType: string })[];
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | { type: "image"; data: string; mimeType: string })[];
  isError: boolean;
  timestamp: number;
}

type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

interface StreamingTextBlock {
  type: "text";
  text: string;
}

/** Normalized shape for rendering a tool call in both streaming and finalized states. */
interface ToolBlockData {
  id: string;
  name: string;
  args: Record<string, any>;
  status: "running" | "done";
  result?: { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] };
  isError?: boolean;
}

interface StreamingToolBlock extends ToolBlockData {
  type: "tool";
}

type StreamingBlock = StreamingTextBlock | StreamingToolBlock;

// ---- Component --------------------------------------------------------------

@customElement("chat-panel")
export class ChatPanel extends LitElement {
  // Use light DOM for Tailwind compatibility
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  client: AppClient | null = null;

  @property({ type: String })
  sessionId = "";

  @property({ attribute: false })
  sessionData: SessionData | null = null;

  @state() private messages: AgentMessage[] = [];
  @state() private isStreaming = false;
  @state() private streamingBlocks: StreamingBlock[] = [];
  @state() private inputText = "";
  @state() private expandedTools = new Set<string>();

  private unsubscribeEvent?: () => void;
  private scrollContainer: HTMLElement | null = null;
  private shouldAutoScroll = true;

  override connectedCallback() {
    super.connectedCallback();
    this.wireClient();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribeEvent?.();
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("client")) {
      this.wireClient();
    }
    // Load messages from session data when it changes
    if (changed.has("sessionData")) {
      if (this.sessionData) {
        this.messages = this.sessionData.messages ?? [];
        this.isStreaming = this.sessionData.state.isStreaming;
        this.streamingBlocks = [];
      } else {
        // Session cleared (e.g. project switch) — reset everything
        this.messages = [];
        this.isStreaming = false;
        this.streamingBlocks = [];
      }
    }
    // Auto-scroll after render
    this.autoScroll();
  }

  private wireClient() {
    this.unsubscribeEvent?.();
    if (!this.client) return;

    this.unsubscribeEvent = this.client.onEvent((sessionId, event) => {
      // Only handle events for our session
      if (sessionId !== this.sessionId) return;
      this.handleAgentEvent(event);
    });
  }

  private handleAgentEvent(event: any) {
    switch (event.type) {
      case "agent_start":
        this.isStreaming = true;
        this.streamingBlocks = [];
        break;

      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame?.type === "text_delta") {
          const blocks = [...this.streamingBlocks];
          const last = blocks[blocks.length - 1];
          if (last && last.type === "text") {
            // Append to existing text block
            blocks[blocks.length - 1] = { ...last, text: last.text + ame.delta };
          } else {
            // Start a new text block (either first block, or after a tool)
            blocks.push({ type: "text", text: ame.delta });
          }
          this.streamingBlocks = blocks;
        }
        break;
      }

      case "tool_execution_start": {
        this.streamingBlocks = [
          ...this.streamingBlocks,
          {
            type: "tool",
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
            status: "running",
          },
        ];
        break;
      }

      case "tool_execution_end": {
        const blocks = this.streamingBlocks.map((b) =>
          b.type === "tool" && b.id === event.toolCallId
            ? { ...b, status: "done" as const, result: event.result, isError: event.isError }
            : b
        );
        this.streamingBlocks = blocks;
        break;
      }

      case "agent_end":
        this.isStreaming = false;
        this.streamingBlocks = [];
        // Append new assistant/toolResult messages from the run.
        // User messages are already added optimistically in handleSend().
        if (event.messages) {
          const newMessages = event.messages.filter(
            (m: AgentMessage) => m.role !== "user"
          );
          this.messages = [...this.messages, ...newMessages];
        }
        break;

      case "message_end":
        // A single message finished — could be mid-agent-run.
        // We refresh the messages array if the event includes the message.
        break;
    }
  }

  private handleSend() {
    const text = this.inputText.trim();
    if (!text || !this.client || !this.sessionId) return;

    if (this.isStreaming) {
      this.client.steer(this.sessionId, text);
    } else {
      this.client.prompt(this.sessionId, text);
    }

    // Optimistically add user message
    this.messages = [
      ...this.messages,
      {
        role: "user",
        content: text,
        timestamp: Date.now(),
      },
    ];

    this.inputText = "";
    this.shouldAutoScroll = true;
  }

  private handleStop() {
    if (this.sessionId) {
      this.client?.abort(this.sessionId);
    }
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
    }
  }

  private handleInput(e: Event) {
    this.inputText = (e.target as HTMLTextAreaElement).value;
  }

  private handleScroll(e: Event) {
    const el = e.target as HTMLElement;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    this.shouldAutoScroll = atBottom;
  }

  private autoScroll() {
    if (!this.shouldAutoScroll) return;
    requestAnimationFrame(() => {
      const container = this.querySelector("#chat-scroll");
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }

  /** Return a short contextual summary for a tool call based on its name & args. */
  private toolSummary(name: string, args: Record<string, any> | undefined): string {
    if (!args) return "";
    switch (name.toLowerCase()) {
      case "bash":
        return args.command ?? "";
      case "read":
        return args.path ?? "";
      case "edit":
        return args.path ?? "";
      case "write":
        return args.path ?? "";
      default:
        // Generic: show first string-valued arg as context
        for (const v of Object.values(args)) {
          if (typeof v === "string" && v.length > 0) return v.length > 120 ? v.slice(0, 117) + "…" : v;
        }
        return "";
    }
  }

  private toggleTool(id: string) {
    const next = new Set(this.expandedTools);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.expandedTools = next;
  }

  private renderMarkdown(text: string): ReturnType<typeof html> {
    try {
      const rendered = marked.parse(text) as string;
      return html`<div class="prose prose-invert prose-sm max-w-none break-words leading-relaxed">${unsafeHTML(rendered)}</div>`;
    } catch {
      return html`<pre class="whitespace-pre-wrap text-sm">${text}</pre>`;
    }
  }

  private renderUserMessage(msg: UserMessage) {
    const text = typeof msg.content === "string"
      ? msg.content
      : msg.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("\n");

    return html`
      <div class="flex justify-end mb-3">
        <div class="bg-blue-600 text-white rounded-2xl rounded-br-md px-3 py-1.5 max-w-[80%] text-sm whitespace-pre-wrap">${text}</div>
      </div>
    `;
  }

  private renderAssistantMessage(msg: AssistantMessage) {
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "toolCall") {
        toolCalls.push(block);
      }
      // Skip thinking blocks in the UI
    }

    const text = textParts.join("\n");

    return html`
      <div class="mb-3">
        ${text ? html`
          <div class="bg-zinc-800 rounded-2xl rounded-bl-md px-4 py-2 max-w-[90%] text-sm">
            ${this.renderMarkdown(text)}
          </div>
        ` : nothing}
        ${toolCalls.map((tc) => this.renderToolCall(tc))}
      </div>
    `;
  }

  private renderToolCall(tc: ToolCall) {
    const result = this.messages.find(
      (m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === tc.id
    );
    return this.renderToolBlock({
      id: tc.id,
      name: tc.name,
      args: tc.arguments,
      status: "done",
      result: result ? { content: result.content } : undefined,
      isError: result?.isError,
    });
  }

  private renderToolBlock(block: ToolBlockData) {
    const expanded = this.expandedTools.has(block.id);
    const summary = this.toolSummary(block.name, block.args);
    const running = block.status === "running";

    const images = block.result?.content?.filter(
      (c): c is { type: "image"; data: string; mimeType: string } => c.type === "image"
    ) ?? [];

    const resultText = block.result?.content
      ?.filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .slice(0, 5000) ?? "";

    // Running tools: show spinner, no expand/collapse
    if (running) {
      return html`
        <div class="mt-1 mb-1 ml-2 border-l-2 border-yellow-500 pl-3">
          <div class="flex items-center gap-2 text-xs text-zinc-400 truncate" title="${summary || block.name}">
            <span class="inline-block w-3 h-3 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>
            <span class="font-mono font-semibold flex-shrink-0">${block.name}</span>
            ${summary ? html`<span class="font-mono text-zinc-500 truncate">${summary}</span>` : nothing}
          </div>
        </div>
      `;
    }

    // Done: expand/collapse with args + result
    return html`
      <div class="mt-1 ml-2 border-l-2 border-zinc-600 pl-3">
        <button
          class="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer truncate max-w-full"
          title="${summary || block.name}"
          @click=${() => this.toggleTool(block.id)}
        >
          <span class="font-mono flex-shrink-0">${expanded ? "▼" : "▶"}</span>
          <span class="font-semibold flex-shrink-0">${block.name}</span>
          ${block.isError ? html`<span class="text-red-400 ml-1 flex-shrink-0">error</span>` : nothing}
          ${summary ? html`<span class="font-mono text-zinc-500 truncate">${summary}</span>` : nothing}
        </button>
        ${!expanded && images.length > 0 ? html`
          <div class="mt-1">
            ${images.map(
              (img) => html`<img src="data:${img.mimeType};base64,${img.data}" class="max-w-full max-h-96 rounded mt-1" alt="Tool result image" />`
            )}
          </div>
        ` : nothing}
        ${expanded ? html`
          <div class="mt-1 text-xs">
            <div class="text-zinc-500 mb-1">Arguments:</div>
            <pre class="bg-zinc-900 rounded p-2 overflow-x-auto text-zinc-300 max-h-48 overflow-y-auto">${JSON.stringify(block.args, null, 2)}</pre>
            ${block.result ? html`
              <div class="text-zinc-500 mt-2 mb-1">Result${block.isError ? " (error)" : ""}:</div>
              ${images.map(
                (img) => html`<img src="data:${img.mimeType};base64,${img.data}" class="max-w-full max-h-96 rounded mt-1 mb-1" alt="Tool result image" />`
              )}
              ${resultText ? html`
                <pre class="bg-zinc-900 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto ${block.isError ? "text-red-400" : "text-zinc-300"}">${resultText}</pre>
              ` : nothing}
            ` : nothing}
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderToolResultMessage(_msg: ToolResultMessage) {
    // Tool results are rendered inline with their corresponding tool calls above.
    // Skip standalone rendering.
    return nothing;
  }

  private renderCompactionSummary() {
    return html`
      <div class="flex items-center gap-3 my-4">
        <div class="flex-1 border-t border-zinc-600"></div>
        <span class="text-[10px] text-zinc-500 uppercase tracking-wide shrink-0">Conversation summarized</span>
        <div class="flex-1 border-t border-zinc-600"></div>
      </div>
    `;
  }

  private renderMessage(msg: AgentMessage) {
    switch (msg.role) {
      case "user":
        return this.renderUserMessage(msg);
      case "assistant":
        return this.renderAssistantMessage(msg);
      case "toolResult":
        return this.renderToolResultMessage(msg);
      case "compaction_summary" as any:
        return this.renderCompactionSummary();
      default:
        return nothing;
    }
  }

  private renderStreamingContent() {
    if (!this.isStreaming) return nothing;

    if (this.streamingBlocks.length === 0) {
      return html`
        <div class="mb-3">
          <div class="flex items-center gap-2 text-sm text-zinc-500">
            <span class="inline-block w-3 h-3 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin"></span>
            Thinking...
          </div>
        </div>
      `;
    }

    return html`
      <div class="mb-3">
        ${this.streamingBlocks.map((block) => {
          if (block.type === "text") {
            return html`
              <div class="bg-zinc-800 rounded-2xl rounded-bl-md px-4 py-2 max-w-[90%] text-sm mb-1">
                ${this.renderMarkdown(block.text)}
              </div>
            `;
          }
          return this.renderToolBlock(block);
        })}
      </div>
    `;
  }

  override render() {
    return html`
      <div class="flex flex-col h-full">
        <!-- Messages area -->
        <div
          id="chat-scroll"
          class="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-1"
          @scroll=${this.handleScroll}
        >
          ${this.messages.length === 0 && !this.isStreaming ? html`
            <div class="flex items-center justify-center h-full text-zinc-500 text-sm">
              Send a message to start a conversation
            </div>
          ` : nothing}
          ${this.messages.map((msg) => this.renderMessage(msg))}
          ${this.renderStreamingContent()}
        </div>

        <!-- Input area -->
        <div class="border-t border-zinc-700 p-3">
          <div class="flex gap-2 items-end">
            <textarea
              class="flex-1 bg-zinc-800 text-zinc-100 rounded-lg px-3 py-2 text-base resize-none outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-500"
              rows="1"
              placeholder="${this.isStreaming ? "Send a steering message..." : "Type a message..."}"
              .value=${this.inputText}
              @input=${this.handleInput}
              @keydown=${this.handleKeyDown}
            ></textarea>
            ${this.isStreaming ? html`
              <button
                class="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer"
                @click=${this.handleStop}
              >
                Stop
              </button>
            ` : nothing}
            <button
              class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              ?disabled=${!this.inputText.trim()}
              @click=${this.handleSend}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-panel": ChatPanel;
  }
}
