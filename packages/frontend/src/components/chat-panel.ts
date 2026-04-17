/**
 * Chat Panel
 *
 * Lit web component that renders the conversation between the user and the
 * agent, handles streaming text updates, tool call display, and user input.
 * Uses light DOM so Tailwind classes work directly.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { FrontendEvent } from "../models/ws-client.js";
import type { ActiveSessionStore } from "../models/stores/active-session-store.js";
import "./markdown-content.js";
import "./session-model-picker.js";
import { getToolRenderer } from "./tools/index.js";
import {
  applyChatEvent,
  parseLeadingSkillBlocks,
  type AgentMessage,
  type AssistantMessage,
  type CompactionSummaryMessage,
  type InjectedSkill,
  type UserMessage,
  type ToolResultMessage,
  type TextContent,
  type ToolCall,
  type ToolBlockData,
  type StreamingBlock,
} from "../models/chat-state.js";
import type { InjectedSkillInfo } from "../models/ws-client.js";

// ---- Component --------------------------------------------------------------

@customElement("chat-panel")
export class ChatPanel extends LitElement {
  // Use light DOM for Tailwind compatibility
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  store: ActiveSessionStore | null = null;

  /** Whether this panel is currently visible (active tab). */
  @property({ type: Boolean })
  visible = false;

  /** Skills available for tab-completion suggestions. */
  @property({ attribute: false })
  availableSkills: InjectedSkillInfo[] = [];

  @state() private messages: AgentMessage[] = [];
  @state() private isStreaming = false;
  @state() private streamingBlocks: StreamingBlock[] = [];
  @state() private inputText = "";
  @state() private expandedSections = new Set<string>();
  @state() private isCompacting = false;
  @state() private errorMessage = "";

  // ---- Skill autocomplete --------------------------------------------------
  @state() private skillSuggestOpen = false;
  @state() private skillSuggestions: InjectedSkillInfo[] = [];
  @state() private skillSuggestIndex = 0;
  /** The `/name` token currently being edited (without the leading `/`). */
  private skillSuggestQuery = "";
  /** Start index of the `/` that opened the current suggestion. */
  private skillSuggestStart = -1;
  private errorTimeout?: ReturnType<typeof setTimeout>;

  @query("textarea") private textarea!: HTMLTextAreaElement;

  private unsubscribeEvent?: () => void;
  private unsubscribeStore?: () => void;
  private scrollContainer: HTMLElement | null = null;
  private shouldAutoScroll = true;
  private lastSessionData: ActiveSessionStore["sessionData"] | undefined;
  private lastSessionMessages: AgentMessage[] = [];

  override connectedCallback() {
    super.connectedCallback();
    this.subscribeToStore();
    this.wireStoreEvents();
    this.syncFromStore();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribeEvent?.();
    this.unsubscribeStore?.();
    if (this.errorTimeout) clearTimeout(this.errorTimeout);
  }

  private showError(message: string) {
    if (this.errorTimeout) clearTimeout(this.errorTimeout);
    this.errorMessage = message;
    this.errorTimeout = setTimeout(() => { this.errorMessage = ""; }, 5000);
  }

  override updated(changed: Map<string, unknown>) {
    // Autofocus the textarea when returning to chat tab (desktop only).
    // Session switches remount the component via keyed(sessionId).
    if (changed.has("visible") && this.visible) {
      this.focusInput();
    }

    // Auto-scroll after render
    this.autoScroll();
  }

  /** Focus the chat textarea, skipping on touch devices to avoid keyboard popup. */
  private focusInput() {
    if ("ontouchstart" in window || navigator.maxTouchPoints > 0) return;
    requestAnimationFrame(() => this.textarea?.focus());
  }

  private subscribeToStore() {
    this.unsubscribeStore?.();
    this.unsubscribeStore = this.store?.subscribe(() => {
      this.syncFromStore();
      this.requestUpdate();
    }) ?? undefined;
  }

  private syncFromStore() {
    const sessionData = this.store?.sessionData;
    // Track whether streaming just ended via metadata so we can reconcile
    // stale in-flight blocks that were never cleaned up by a missed agent_end.
    let streamingJustEnded = false;
    if (sessionData && sessionData !== this.lastSessionData) {
      const wasStreaming = this.isStreaming;
      this.lastSessionData = sessionData;
      this.isStreaming = sessionData.state.isStreaming;

      if (wasStreaming && !this.isStreaming) {
        // Streaming ended while we weren't watching (missed agent_end).
        // Clear stale streaming blocks so persisted messages can load.
        this.streamingBlocks = [];
        streamingJustEnded = true;
      }
    }

    const sessionMessages = this.store?.sessionMessages ?? [];
    if (sessionMessages !== this.lastSessionMessages || streamingJustEnded) {
      this.lastSessionMessages = sessionMessages;
      // Session switches remount the component via keyed(sessionId), so the
      // only time we reuse persisted messages is when this panel is empty or
      // when no in-flight streaming UI needs to be preserved.
      if (
        this.messages.length === 0
        || (!this.isStreaming && this.streamingBlocks.length === 0)
      ) {
        this.messages = sessionMessages;
      }
    }
  }

  private wireStoreEvents() {
    this.unsubscribeEvent?.();
    if (!this.store) return;

    this.unsubscribeEvent = this.store.onEvent((sessionId, _projectId, event) => {
      // WS-level errors (e.g. command failures) arrive with empty sessionId
      if (event.type === "ws_error") {
        this.handleAgentEvent(event);
        return;
      }
      // Only handle session events for our session
      if (sessionId !== this.store?.sessionId) return;
      this.handleAgentEvent(event);
    });
  }

  private handleAgentEvent(event: FrontendEvent) {
    // ws_error is handled locally (needs DOM method); non-chat events
    // (task_updated, session_created) are ignored by this component.
    if (event.type === "ws_error") {
      this.showError(event.error || "Something went wrong");
      return;
    }
    if (event.type === "ws_ack") {
      this.handleWsAck(event);
      return;
    }
    if (
      event.type === "task_updated"
      || event.type === "session_created"
      || event.type === "session_updated"
      || event.type === "open_file"
    ) {
      return;
    }

    const prev = {
      messages: this.messages,
      isStreaming: this.isStreaming,
      streamingBlocks: this.streamingBlocks,
      isCompacting: this.isCompacting,
      shouldAutoScroll: this.shouldAutoScroll,
      errorMessage: this.errorMessage,
    };
    const next = applyChatEvent(prev, event);

    // Apply only changed fields to trigger minimal Lit reactivity.
    if (next.messages !== prev.messages) this.messages = next.messages;
    if (next.isStreaming !== prev.isStreaming) this.isStreaming = next.isStreaming;
    if (next.streamingBlocks !== prev.streamingBlocks) this.streamingBlocks = next.streamingBlocks;
    if (next.isCompacting !== prev.isCompacting) this.isCompacting = next.isCompacting;
    if (next.shouldAutoScroll !== prev.shouldAutoScroll) this.shouldAutoScroll = next.shouldAutoScroll;
    if (next.errorMessage !== prev.errorMessage) this.errorMessage = next.errorMessage;
  }

  private handleSend() {
    const text = this.inputText.trim();
    const sessionId = this.store?.sessionId ?? "";
    if (!text || !sessionId || !this.store) return;

    const sent = this.isStreaming
      ? this.store.steer(text)
      : this.store.prompt(text);
    if (!sent) return;

    const timestamp = Date.now();
    this.messages = [
      ...this.messages,
      {
        role: "user",
        content: text,
        timestamp,
      },
    ];
    // Track the locally-appended user message so we can attach injected skill
    // metadata when the backend's ack comes back.
    this._pendingUserMessageTimestamp = timestamp;

    this.inputText = "";
    this.shouldAutoScroll = true;
    this.closeSkillSuggest();
  }

  /** Timestamp of the most recent optimistically-appended user message. */
  private _pendingUserMessageTimestamp: number | null = null;

  private handleWsAck(event: { type: "ws_ack"; command: string; skills?: InjectedSkillInfo[] }) {
    const ts = this._pendingUserMessageTimestamp;
    if (ts == null) return;
    if (event.command !== "prompt" && event.command !== "steer") return;
    this._pendingUserMessageTimestamp = null;
    if (!event.skills || event.skills.length === 0) return;

    const next = this.messages.map((m) => {
      if (m.role === "user" && m.timestamp === ts) {
        return { ...m, injectedSkills: event.skills };
      }
      return m;
    });
    this.messages = next;
  }

  private handleStop() {
    this.store?.abort();
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (this.skillSuggestOpen && this.skillSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.skillSuggestIndex = (this.skillSuggestIndex + 1) % this.skillSuggestions.length;
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.skillSuggestIndex =
          (this.skillSuggestIndex - 1 + this.skillSuggestions.length) % this.skillSuggestions.length;
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        this.acceptSkillSuggestion();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeSkillSuggest();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
    }
  }

  private handleInput(e: Event) {
    if (e.target instanceof HTMLTextAreaElement) {
      this.inputText = e.target.value;
      this.updateSkillSuggest(e.target);
    }
  }

  // ---- Skill autocomplete -------------------------------------------------

  private updateSkillSuggest(textarea: HTMLTextAreaElement) {
    const caret = textarea.selectionStart ?? this.inputText.length;
    const value = this.inputText;
    // Find the `/` starting the token the caret is inside.
    let start = -1;
    for (let i = caret - 1; i >= 0; i--) {
      const ch = value[i];
      if (ch === "/") { start = i; break; }
      if (!/[a-z0-9-]/i.test(ch)) break;
    }
    if (start === -1) { this.closeSkillSuggest(); return; }
    // Require start-of-string or whitespace before the `/`.
    const prev = start === 0 ? "" : value[start - 1];
    if (prev !== "" && !/\s/.test(prev)) { this.closeSkillSuggest(); return; }
    // Everything after `/` up to caret must be a valid partial name.
    const partial = value.slice(start + 1, caret);
    if (!/^[a-z0-9-]*$/i.test(partial)) { this.closeSkillSuggest(); return; }

    const query = partial.toLowerCase();
    const matches = this.availableSkills.filter((s) => s.name.toLowerCase().startsWith(query));
    if (matches.length === 0) { this.closeSkillSuggest(); return; }

    this.skillSuggestQuery = partial;
    this.skillSuggestStart = start;
    this.skillSuggestions = matches;
    if (this.skillSuggestIndex >= matches.length) this.skillSuggestIndex = 0;
    this.skillSuggestOpen = true;
  }

  private closeSkillSuggest() {
    if (!this.skillSuggestOpen && this.skillSuggestions.length === 0) return;
    this.skillSuggestOpen = false;
    this.skillSuggestions = [];
    this.skillSuggestIndex = 0;
    this.skillSuggestStart = -1;
    this.skillSuggestQuery = "";
  }

  private acceptSkillSuggestion(index?: number) {
    const picked = this.skillSuggestions[index ?? this.skillSuggestIndex];
    if (!picked || this.skillSuggestStart < 0) return;
    const before = this.inputText.slice(0, this.skillSuggestStart);
    const afterStart = this.skillSuggestStart + 1 + this.skillSuggestQuery.length;
    const after = this.inputText.slice(afterStart);
    const insertion = `/${picked.name} `;
    this.inputText = before + insertion + after;

    const caret = before.length + insertion.length;
    this.closeSkillSuggest();

    // Restore caret after the DOM reflects the new value.
    queueMicrotask(() => {
      if (!this.textarea) return;
      this.textarea.focus();
      this.textarea.setSelectionRange(caret, caret);
    });
  }

  private handleScroll(e: Event) {
    if (!(e.target instanceof HTMLElement)) return;
    const atBottom = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 50;
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

  private toggleSection(id: string) {
    const next = new Set(this.expandedSections);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.expandedSections = next;
  }


  private renderUserMessage(msg: UserMessage) {
    const rawText = typeof msg.content === "string"
      ? msg.content
      : msg.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("\n");

    // Historical messages (loaded from the DB) have the raw `<skill>` blocks
    // in content. Strip them here and derive pills from the `name="..."`
    // attributes. Live messages use `injectedSkills` from the ack/broadcast.
    const { visible, skills: parsedSkills } = parseLeadingSkillBlocks(rawText);
    const pills: InjectedSkill[] = msg.injectedSkills && msg.injectedSkills.length > 0
      ? msg.injectedSkills
      : parsedSkills;

    return html`
      <div class="flex flex-col items-end mb-3">
        ${pills.length > 0 ? html`
          <div class="flex flex-wrap gap-1 justify-end mb-1 max-w-[80%]">
            ${pills.map((skill) => this.renderSkillPill(skill, msg.timestamp))}
          </div>
        ` : nothing}
        <div class="bg-blue-600 text-white rounded-2xl rounded-br-md px-3 py-1.5 max-w-[80%] text-sm whitespace-pre-wrap">${visible}</div>
      </div>
    `;
  }

  private renderSkillPill(skill: InjectedSkill, messageTimestamp: number) {
    const id = `skill-${messageTimestamp}-${skill.name}`;
    const expanded = this.expandedSections.has(id);
    const hasDescription = !!skill.description;
    return html`
      <div class="flex flex-col items-end">
        <button
          class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-700/80 border border-zinc-600 text-[11px] text-zinc-200 ${hasDescription ? "hover:bg-zinc-600 cursor-pointer" : "cursor-default"}"
          title="${hasDescription ? (expanded ? "Hide description" : "Show description") : "Skill injected"}"
          ?disabled=${!hasDescription}
          @click=${() => hasDescription && this.toggleSection(id)}
        >
          <span class="font-mono">/${skill.name}</span>
          ${hasDescription ? html`<span class="text-zinc-400 font-mono text-[10px]">${expanded ? "▼" : "▶"}</span>` : nothing}
        </button>
        ${expanded && hasDescription ? html`
          <div class="mt-1 max-w-[320px] bg-zinc-800 border border-zinc-600 rounded-md px-2 py-1 text-[11px] text-zinc-300">
            ${skill.description}
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderAssistantMessage(msg: AssistantMessage) {
    const parts: unknown[] = [];
    const textBuffer: string[] = [];

    const flushText = () => {
      if (textBuffer.length === 0) return;
      const text = textBuffer.join("\n");
      textBuffer.length = 0;
      parts.push(html`
        <div class="bg-zinc-800 border-l-2 border-blue-400/60 rounded-2xl rounded-bl-md px-4 py-2 max-w-[90%] text-sm">
          <markdown-content .text=${text}></markdown-content>
        </div>
      `);
    };

    for (const block of msg.content) {
      if (block.type === "text") {
        textBuffer.push(block.text);
        continue;
      }

      if (block.type === "toolCall") {
        flushText();
        parts.push(this.renderToolCall(block));
      }
      // Skip thinking blocks in the UI
    }

    flushText();

    return html`
      <div class="mb-3">
        ${parts}
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
      result: result ? { content: result.content, details: result.details } : undefined,
      isError: result?.isError,
    });
  }

  private renderToolBlock(block: ToolBlockData) {
    const renderer = getToolRenderer(block.name);
    return html`<div class="max-w-[90%]">${renderer.render(block)}</div>`;
  }

  private renderToolResultMessage(_msg: ToolResultMessage) {
    // Tool results are rendered inline with their corresponding tool calls above.
    // Skip standalone rendering.
    return nothing;
  }

  private renderCompactionSummary(msg: CompactionSummaryMessage) {
    const rawSummary = msg.content || msg.summary;
    const summary = rawSummary && rawSummary !== "Conversation summarized" ? rawSummary : null;
    const id = `compaction-${msg.timestamp || 0}`;
    const expanded = this.expandedSections.has(id);

    return html`
      <div class="my-4">
        <div class="flex items-center gap-3">
          <div class="flex-1 border-t border-zinc-600"></div>
          <button
            class="flex items-center gap-1.5 text-[10px] text-zinc-500 uppercase tracking-wide shrink-0 ${summary ? 'hover:text-zinc-300 cursor-pointer' : ''} transition-colors"
            @click=${() => summary && this.toggleSection(id)}
            ?disabled=${!summary}
          >
            ${summary ? html`<span class="font-mono">${expanded ? '▼' : '▶'}</span>` : nothing}
            Conversation summarized
          </button>
          <div class="flex-1 border-t border-zinc-600"></div>
        </div>
        ${expanded && summary ? html`
          <div class="mt-2 mx-4 bg-zinc-800/50 rounded-lg px-4 py-3 text-sm border border-zinc-700">
            <markdown-content .text=${summary}></markdown-content>
          </div>
        ` : nothing}
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
      case "compactionSummary":
        return this.renderCompactionSummary(msg);
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
              <div class="bg-zinc-800 border-l-2 border-blue-400/60 rounded-2xl rounded-bl-md px-4 py-2 max-w-[90%] text-sm mb-1">
                <markdown-content .text=${block.text} .streaming=${true}></markdown-content>
              </div>
            `;
          }
          return this.renderToolBlock(block);
        })}
        ${this.isCompacting ? html`
          <div class="flex items-center gap-2 text-xs text-amber-500/70 mt-2 ml-2">
            <span class="inline-block w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>
            Summarizing conversation…
          </div>
        ` : nothing}
      </div>
    `;
  }

  private renderSkillSuggestions() {
    if (!this.skillSuggestOpen || this.skillSuggestions.length === 0) return nothing;
    return html`
      <div class="absolute left-0 right-0 bottom-[calc(100%+0.5rem)] z-20 bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden shadow-2xl shadow-black/60 origin-bottom animate-[skill-popover-in_120ms_ease-out]">
        <div class="px-3 py-1 bg-blue-500/10 border-b border-blue-500/30 text-[10px] uppercase tracking-wide text-blue-300/80 font-semibold">
          Skills
        </div>
        <div class="max-h-60 overflow-y-auto">
          ${this.skillSuggestions.map((s, i) => {
            const selected = i === this.skillSuggestIndex;
            return html`
              <button
                class="flex flex-col w-full items-start gap-0.5 text-left px-3 py-1.5 text-sm border-l-2 cursor-pointer ${selected ? "bg-zinc-800 border-blue-400" : "border-transparent hover:bg-zinc-800/60"}"
                @mousedown=${(e: Event) => { e.preventDefault(); this.acceptSkillSuggestion(i); }}
                @mouseenter=${() => { this.skillSuggestIndex = i; }}
              >
                <span class="font-mono text-zinc-100">/${s.name}</span>
                ${s.description ? html`<span class="text-xs text-zinc-400 leading-tight">${s.description}</span>` : nothing}
              </button>
            `;
          })}
        </div>
      </div>
    `;
  }

  override render() {
    const sessionId = this.store?.sessionId ?? "";
    const sessionData = this.store?.sessionData;

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
        <div class="border-t border-zinc-700 px-3 pt-2 pb-[var(--input-bottom)]">
          ${this.errorMessage ? html`
            <div class="flex items-center gap-2 mb-2 px-3 py-1.5 bg-red-900/30 border border-red-800/50 rounded-lg text-xs text-red-300">
              <span class="flex-1">${this.errorMessage}</span>
              <button class="text-red-400 hover:text-red-200 cursor-pointer" @click=${() => { this.errorMessage = ""; }}>✕</button>
            </div>
          ` : nothing}
          ${sessionData?.state.model ? html`
            <div class="mb-2 flex items-center justify-start leading-none">
              <session-model-picker
                .sessionId=${sessionId}
                .sessionData=${sessionData}
                .updateSessionModel=${this.store?.updateSessionModel.bind(this.store) ?? null}
              ></session-model-picker>
            </div>
          ` : nothing}
          <div class="relative">
            ${this.renderSkillSuggestions()}
            <div class="flex gap-2 items-end">
              <textarea
              class="flex-1 bg-zinc-800 text-zinc-100 rounded-lg px-3 py-2 text-base resize-none outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-500"
              rows="1"
              placeholder="${this.isStreaming ? "Send a steering message..." : "Type a message..."}"
              .value=${this.inputText}
              @input=${this.handleInput}
              @keydown=${this.handleKeyDown}
              @blur=${() => setTimeout(() => this.closeSkillSuggest(), 100)}
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
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-panel": ChatPanel;
  }
}
