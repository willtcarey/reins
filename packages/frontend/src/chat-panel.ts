/**
 * Herald Chat Panel
 *
 * Lit web component that renders the conversation between the user and the
 * agent, handles streaming text updates, tool call display, and user input.
 * Uses light DOM so Tailwind classes work directly.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state, query } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import type { HeraldClient } from "./ws-client.js";

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

interface PendingTool {
  name: string;
  args: any;
}

// ---- Component --------------------------------------------------------------

@customElement("herald-chat")
export class HeraldChat extends LitElement {
  // Use light DOM for Tailwind compatibility
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  client: HeraldClient | null = null;

  @state() private messages: AgentMessage[] = [];
  @state() private isStreaming = false;
  @state() private streamingText = "";
  @state() private pendingToolCalls = new Map<string, PendingTool>();
  @state() private inputText = "";
  @state() private expandedTools = new Set<string>();

  private unsubscribeEvent?: () => void;
  private unsubscribeInit?: () => void;
  private scrollContainer: HTMLElement | null = null;
  private shouldAutoScroll = true;

  override connectedCallback() {
    super.connectedCallback();
    this.wireClient();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribeEvent?.();
    this.unsubscribeInit?.();
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("client")) {
      this.wireClient();
    }
    // Auto-scroll after render
    this.autoScroll();
  }

  private wireClient() {
    this.unsubscribeEvent?.();
    this.unsubscribeInit?.();
    if (!this.client) return;

    this.unsubscribeInit = this.client.onInit((data) => {
      this.messages = data.messages ?? [];
      this.isStreaming = data.state.isStreaming;
      this.streamingText = "";
      this.pendingToolCalls = new Map();
    });

    this.unsubscribeEvent = this.client.onEvent((event) => {
      this.handleAgentEvent(event);
    });
  }

  private handleAgentEvent(event: any) {
    switch (event.type) {
      case "agent_start":
        this.isStreaming = true;
        this.streamingText = "";
        this.pendingToolCalls = new Map();
        break;

      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (ame?.type === "text_delta") {
          this.streamingText += ame.delta;
        }
        break;
      }

      case "tool_execution_start":
        this.pendingToolCalls = new Map(this.pendingToolCalls);
        this.pendingToolCalls.set(event.toolCallId, {
          name: event.toolName,
          args: event.args,
        });
        break;

      case "tool_execution_end": {
        this.pendingToolCalls = new Map(this.pendingToolCalls);
        this.pendingToolCalls.delete(event.toolCallId);
        break;
      }

      case "agent_end":
        this.isStreaming = false;
        this.streamingText = "";
        this.pendingToolCalls = new Map();
        if (event.messages) {
          this.messages = event.messages;
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
    if (!text || !this.client) return;

    if (this.isStreaming) {
      // If streaming, treat as steer
      this.client.steer(text);
    } else {
      this.client.prompt(text);
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
    this.client?.abort();
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
      return html`<div class="prose prose-invert prose-sm max-w-none break-words">${unsafeHTML(rendered)}</div>`;
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
        <div class="bg-blue-600 text-white rounded-2xl rounded-br-md px-4 py-2 max-w-[80%] text-sm whitespace-pre-wrap">
          ${text}
        </div>
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
    const expanded = this.expandedTools.has(tc.id);
    // Find matching tool result
    const result = this.messages.find(
      (m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === tc.id
    );

    return html`
      <div class="mt-1 ml-2 border-l-2 border-zinc-600 pl-3">
        <button
          class="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
          @click=${() => this.toggleTool(tc.id)}
        >
          <span class="font-mono">${expanded ? "▼" : "▶"}</span>
          <span class="font-semibold">${tc.name}</span>
          ${result?.isError ? html`<span class="text-red-400 ml-1">error</span>` : nothing}
        </button>
        ${expanded ? html`
          <div class="mt-1 text-xs">
            <div class="text-zinc-500 mb-1">Arguments:</div>
            <pre class="bg-zinc-900 rounded p-2 overflow-x-auto text-zinc-300 max-h-48 overflow-y-auto">${JSON.stringify(tc.arguments, null, 2)}</pre>
            ${result ? html`
              <div class="text-zinc-500 mt-2 mb-1">Result${result.isError ? " (error)" : ""}:</div>
              <pre class="bg-zinc-900 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto ${result.isError ? "text-red-400" : "text-zinc-300"}">${this.getToolResultText(result)}</pre>
            ` : nothing}
          </div>
        ` : nothing}
      </div>
    `;
  }

  private getToolResultText(msg: ToolResultMessage): string {
    return msg.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .slice(0, 5000); // Truncate very long results for display
  }

  private renderToolResultMessage(_msg: ToolResultMessage) {
    // Tool results are rendered inline with their corresponding tool calls above.
    // Skip standalone rendering.
    return nothing;
  }

  private renderMessage(msg: AgentMessage) {
    switch (msg.role) {
      case "user":
        return this.renderUserMessage(msg);
      case "assistant":
        return this.renderAssistantMessage(msg);
      case "toolResult":
        return this.renderToolResultMessage(msg);
      default:
        return nothing;
    }
  }

  private renderStreamingContent() {
    if (!this.isStreaming) return nothing;

    return html`
      <div class="mb-3">
        ${this.streamingText ? html`
          <div class="bg-zinc-800 rounded-2xl rounded-bl-md px-4 py-2 max-w-[90%] text-sm">
            ${this.renderMarkdown(this.streamingText)}
          </div>
        ` : nothing}
        ${this.pendingToolCalls.size > 0 ? html`
          <div class="mt-1 ml-2 space-y-1">
            ${Array.from(this.pendingToolCalls.entries()).map(
              ([id, tool]) => html`
                <div class="border-l-2 border-yellow-500 pl-3 flex items-center gap-2 text-xs text-zinc-400">
                  <span class="inline-block w-3 h-3 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin"></span>
                  <span class="font-mono font-semibold">${tool.name}</span>
                </div>
              `
            )}
          </div>
        ` : nothing}
        ${!this.streamingText && this.pendingToolCalls.size === 0 ? html`
          <div class="flex items-center gap-2 text-sm text-zinc-500">
            <span class="inline-block w-3 h-3 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin"></span>
            Thinking...
          </div>
        ` : nothing}
      </div>
    `;
  }

  override render() {
    return html`
      <div class="flex flex-col h-full">
        <!-- Messages area -->
        <div
          id="chat-scroll"
          class="flex-1 overflow-y-auto p-4 space-y-1"
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
              class="flex-1 bg-zinc-800 text-zinc-100 rounded-lg px-3 py-2 text-sm resize-none outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-500"
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
    "herald-chat": HeraldChat;
  }
}
