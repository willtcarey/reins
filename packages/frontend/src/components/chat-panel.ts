/**
 * Chat Panel
 *
 * Lit web component that renders the conversation between the user and the
 * agent, handles streaming text updates, tool call display, and user input.
 * Uses light DOM so Tailwind classes work directly.
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { ActiveSessionStore } from "../models/stores/active-session-store.js";
import type { ConversationEntry } from "../models/stores/conversations-store.js";
import type { ProjectStore } from "../models/stores/project-store.js";
import "./markdown-content.js";
import "./session-model-picker.js";
import "./chat-composer.js";
import { getToolRenderer } from "./tools/index.js";
import {
  type AgentMessage,
  type AssistantMessage,
  type CompactionSummaryMessage,
  type UserMessage,
  type ToolResultMessage,
  type ToolCall,
  type ToolBlockData,
  type StreamingBlock,
} from "../models/chat-state.js";
import {
  imageAspectRatioStyle,
  imageBlockSrc,
  imagesFromContent,
  imageSizeHint,
  textFromClientContent,
  type ChatImageBlock,
} from "../models/chat-content.js";
import type { ChatComposer, ChatComposerSubmitDetail } from "./chat-composer.js";
import { ChatSendAnimator } from "../helpers/chat-send-animation.js";
import { openImageViewerEvent } from "./events.js";
import { ChatHistoryController } from "../controllers/chat-history-controller.js";

// ---- Component --------------------------------------------------------------

@customElement("chat-panel")
export class ChatPanel extends LitElement {
  // Use light DOM for Tailwind compatibility
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false })
  store: ActiveSessionStore | null = null;

  /** Per-project store for the active session's project. Passed through to
   *  `<skill-suggest>` so it can read the available skills. */
  @property({ attribute: false })
  projectStore: ProjectStore | null = null;

  /** Whether this panel is currently visible (active tab). */
  @property({ type: Boolean })
  visible = false;

  @state() private expandedSections = new Set<string>();
  @state() private animatingUserMessageKeys = new Set<string>();

  @query("chat-composer") private composer?: ChatComposer;

  private sendAnimator = new ChatSendAnimator(this);
  private history = new ChatHistoryController(this, {
    hasEarlierMessages: () => this.store?.conversation.hasEarlierMessages ?? false,
    loadPrevious: () => this.store?.loadEarlierMessages() ?? Promise.resolve(false),
  });
  private unsubscribeStore?: () => void;
  private shouldAutoScroll = true;

  override connectedCallback() {
    super.connectedCallback();
    this.subscribeToStore();
  }

  override disconnectedCallback() {
    this.sendAnimator.cancel();
    super.disconnectedCallback();
    this.unsubscribeStore?.();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("store")) {
      this.resetSessionState();
      this.subscribeToStore();
    }
  }

  private resetSessionState() {
    this.sendAnimator.cancel();
    this.expandedSections = new Set();
    this.animatingUserMessageKeys = new Set();
    this.shouldAutoScroll = true;
    this.history.reset();
  }

  private get messageEntries(): ConversationEntry[] {
    return this.store?.conversation.entries ?? [];
  }

  private get messages(): AgentMessage[] {
    return this.messageEntries.map((entry) => entry.message);
  }

  private get isStreaming(): boolean {
    return this.store?.sessionData.activityState === "running";
  }

  private get streamingBlocks(): StreamingBlock[] {
    return this.store?.conversation.streamingBlocks ?? [];
  }

  private get isCompacting(): boolean {
    return this.store?.conversation.isCompacting ?? false;
  }

  private get errorMessage(): string {
    return this.store?.conversation.errorMessage ?? "";
  }

  override updated(changed: Map<string, unknown>) {
    // Autofocus the composer when returning to chat tab (desktop only).
    // Session switches remount the component via keyed(sessionId).
    if (changed.has("visible") && this.visible) {
      this.focusInput();
    }

    // Auto-scroll after render. The send animator measures on the following
    // frame, after this scroll has placed the optimistic message.
    this.autoScroll();
    this.sendAnimator.cancelIfTargetMissing();
  }

  /** Focus the chat composer, skipping on touch devices to avoid keyboard popup. */
  private focusInput() {
    if ("ontouchstart" in window || navigator.maxTouchPoints > 0) return;
    requestAnimationFrame(() => this.composer?.focusInput());
  }

  private subscribeToStore() {
    this.unsubscribeStore?.();
    this.unsubscribeStore = this.store?.subscribe(() => {
      this.requestUpdate();
    }) ?? undefined;
  }

  private handleSend(e: CustomEvent<ChatComposerSubmitDetail>) {
    const { content, source } = e.detail;
    const sessionId = this.store?.sessionId ?? "";
    if (!sessionId || !this.store) return;

    const wasStreaming = this.isStreaming;
    const submittedEntry = wasStreaming
      ? this.store.steer(content)
      : this.store.prompt(content);
    if (!submittedEntry) return;

    // The returned local ID identifies this exact local optimistic insertion.
    // Persisted refreshes and peer/reconciled history never pass this boundary.
    const messageKey = submittedEntry.localId;
    const shouldAnimate = source != null && this.sendAnimator.canAnimateOutgoingMessage();
    if (shouldAnimate) {
      this.animatingUserMessageKeys = new Set([...this.animatingUserMessageKeys, messageKey]);
    }

    this.shouldAutoScroll = true;
    this.composer?.closeSuggestions();
    if (shouldAnimate) {
      void this.sendAnimator.animate(
        messageKey,
        source,
        () => this.revealOutgoingMessage(messageKey),
      );
    }
  }

  private handleStop() {
    this.store?.abort();
  }

  private handleScroll(e: Event) {
    if (!(e.target instanceof HTMLElement)) return;
    const atBottom = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 50;
    this.shouldAutoScroll = atBottom;
    this.history.handleScroll(e.target);
  }

  private handleHistoryTouchStart() {
    this.history.handleTouchStart();
  }

  private handleLoadPreviousMessages() {
    const container = this.querySelector<HTMLElement>("#chat-scroll");
    if (!container) return;
    this.shouldAutoScroll = false;
    return this.history.loadPrevious(container);
  }

  private handleMessageTouchMove() {
    this.composer?.blurInput();
  }

  private autoScroll() {
    if (!this.shouldAutoScroll || this.sendAnimator.scrollLocked) return;
    requestAnimationFrame(() => {
      const container = this.querySelector("#chat-scroll");
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }

  private userMessageKey(timestamp: number): string {
    return `user-${timestamp}`;
  }

  private conversationEntryKey(entry: ConversationEntry): string {
    return entry.id ?? entry.localId;
  }

  private conversationMessageKey(msg: AgentMessage): string {
    switch (msg.role) {
      case "user":
        return this.userMessageKey(msg.timestamp);
      case "assistant":
        return `assistant-${msg.timestamp}`;
      case "compactionSummary":
        return `compaction-${msg.timestamp || 0}`;
      case "toolResult":
        return `tool-result-${msg.toolCallId}-${msg.timestamp}`;
    }
  }

  private revealOutgoingMessage(messageKey: string) {
    if (!this.animatingUserMessageKeys.has(messageKey)) return;
    const next = new Set(this.animatingUserMessageKeys);
    next.delete(messageKey);
    this.animatingUserMessageKeys = next;
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


  private renderChatImage(image: ChatImageBlock, sessionId: string) {
    const hint = imageSizeHint(image);
    const src = imageBlockSrc(sessionId, image);
    const alt = "filename" in image && image.filename ? image.filename : "Attached image";
    const className = "block h-auto w-auto max-h-64 max-w-full rounded-lg border border-zinc-700 bg-zinc-900 transition-opacity group-hover:opacity-90";
    const openImage = (event: Event) => {
      event.stopPropagation();
      this.dispatchEvent(openImageViewerEvent({ src, alt, title: alt }));
    };
    const imageTemplate = !hint
      ? html`
        <img
          src=${src}
          alt=${alt}
          class=${className}
          loading="lazy"
        />
      `
      : html`
        <img
          src=${src}
          alt=${alt}
          width=${hint.width}
          height=${hint.height}
          style=${imageAspectRatioStyle(image)}
          class=${className}
          loading="lazy"
        />
      `;

    return html`
      <button
        type="button"
        class="group ml-auto inline-flex max-w-full cursor-zoom-in justify-end rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 focus:ring-offset-zinc-900"
        aria-label=${`Open image full screen: ${alt}`}
        title="Open image full screen"
        @click=${openImage}
      >
        ${imageTemplate}
      </button>
    `;
  }

  private renderUserMessage(msg: UserMessage, conversationKey = this.conversationMessageKey(msg)) {
    const text = typeof msg.content === "string"
      ? msg.content
      : textFromClientContent(msg.content);
    const images = imagesFromContent(msg.content);
    const sessionId = this.store?.sessionId ?? "";
    const messageKey = conversationKey;
    const isAnimating = this.animatingUserMessageKeys.has(messageKey);

    return html`
      <div
        data-role="user-message-row"
        data-message-key=${messageKey}
        data-conversation-key=${conversationKey}
        class="flex justify-end mb-3 ${isAnimating ? 'sent-message-target-hidden' : ''}"
      >
        <div data-role="user-message-animation-target" class="flex max-w-[80%] flex-col items-end gap-2">
          ${images.length > 0 ? html`
            <div data-role="user-message-attachments" class="grid grid-cols-1 gap-2 justify-items-end max-w-full">
              ${images.map((image) => this.renderChatImage(image, sessionId))}
            </div>
          ` : nothing}
          ${text ? html`
            <div data-role="user-message-bubble" class="bg-blue-600 text-white rounded-2xl rounded-br-md px-3 py-1.5 max-w-full text-sm">
              <div class="whitespace-pre-wrap">${text}</div>
            </div>
          ` : nothing}
        </div>
      </div>
    `;
  }

  private renderAssistantMessage(msg: AssistantMessage, conversationKey = this.conversationMessageKey(msg)) {
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
      <div data-conversation-key=${conversationKey} class="mb-3">
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
    return html`<div class="max-w-[90%]">${renderer.render({ ...block, sessionId: this.store?.sessionId ?? "" })}</div>`;
  }

  private renderToolResultMessage(_msg: ToolResultMessage) {
    // Tool results are rendered inline with their corresponding tool calls above.
    // Skip standalone rendering.
    return nothing;
  }

  private renderCompactionSummary(msg: CompactionSummaryMessage, conversationKey = this.conversationMessageKey(msg)) {
    const rawSummary = msg.content || msg.summary;
    const summary = rawSummary && rawSummary !== "Conversation summarized" ? rawSummary : null;
    const id = `compaction-${msg.timestamp || 0}`;
    const expanded = this.expandedSections.has(id);

    return html`
      <div data-conversation-key=${conversationKey} class="my-4">
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

  private renderMessageEntry(entry: ConversationEntry) {
    return this.renderMessage(entry.message, this.conversationEntryKey(entry));
  }

  private renderMessage(msg: AgentMessage, conversationKey = this.conversationMessageKey(msg)) {
    switch (msg.role) {
      case "user":
        return this.renderUserMessage(msg, conversationKey);
      case "assistant":
        return this.renderAssistantMessage(msg, conversationKey);
      case "toolResult":
        return this.renderToolResultMessage(msg);
      case "compactionSummary":
        return this.renderCompactionSummary(msg, conversationKey);
      default:
        return nothing;
    }
  }

  private renderCompactingIndicator() {
    return html`
      <div class="flex items-center gap-2 text-sm text-amber-500/80">
        <span class="inline-block w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></span>
        Summarizing conversation…
      </div>
    `;
  }

  private renderThinkingIndicator() {
    return html`
      <div class="flex items-center gap-2 text-sm text-zinc-500">
        <span class="inline-block w-3 h-3 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin"></span>
        Thinking...
      </div>
    `;
  }

  private renderStreamingContent() {
    const hasStreamingBlocks = this.streamingBlocks.length > 0;
    const showThinking = this.isStreaming && !this.isCompacting && !hasStreamingBlocks;
    if (!showThinking && !hasStreamingBlocks && !this.isCompacting) return nothing;

    return html`
      <div
        data-role="streaming-content"
        data-conversation-key="streaming-content"
        class="mb-3 space-y-2"
      >
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
        ${showThinking ? this.renderThinkingIndicator() : nothing}
        ${this.isCompacting ? this.renderCompactingIndicator() : nothing}
      </div>
    `;
  }

  override render() {
    const sessionId = this.store?.sessionId ?? "";
    const sessionData = this.store?.sessionData;

    return html`
      <div class="relative flex flex-col h-full">
        <!-- Messages area -->
        <div
          id="chat-scroll"
          class="flex-1 overflow-y-auto overflow-x-hidden [overflow-anchor:none] p-4 space-y-1"
          @scroll=${this.handleScroll}
          @touchstart=${this.handleHistoryTouchStart}
          @touchmove=${this.handleMessageTouchMove}
        >
          ${this.store?.conversation.hasEarlierMessages ? html`
            <div class="flex justify-center pb-2">
              <button
                data-role="load-previous-messages"
                class="rounded-md border border-zinc-700 bg-zinc-800/70 px-2.5 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
                type="button"
                ?disabled=${this.history.loading}
                aria-busy=${this.history.loading ? "true" : "false"}
                @click=${this.handleLoadPreviousMessages}
              >
                ${this.history.loading ? "Loading previous messages…" : "Load previous messages"}
              </button>
            </div>
          ` : nothing}
          ${this.messages.length === 0 && !this.isStreaming && !this.isCompacting ? html`
            <div class="flex items-center justify-center h-full text-zinc-500 text-sm">
              Send a message to start a conversation
            </div>
          ` : nothing}
          ${repeat(
            this.messageEntries,
            (entry) => this.conversationEntryKey(entry),
            (entry) => this.renderMessageEntry(entry),
          )}
          ${this.renderStreamingContent()}
        </div>

        <!-- Input area -->
        <div class="border-t border-zinc-700 px-3 pt-2 pb-[var(--input-bottom)]">
          ${this.errorMessage ? html`
            <div class="flex items-center gap-2 mb-2 px-3 py-1.5 bg-red-900/30 border border-red-800/50 rounded-lg text-xs text-red-300">
              <span class="flex-1">${this.errorMessage}</span>
              <button class="text-red-400 hover:text-red-200 cursor-pointer" @click=${() => { this.store?.clearConversationError(); }}>✕</button>
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
          <chat-composer
            .projectStore=${this.projectStore}
            .uploadAttachments=${typeof this.store?.uploadAttachments === "function" ? this.store.uploadAttachments.bind(this.store) : null}
            .sessionId=${sessionId}
            .streaming=${this.isStreaming}
            @composer-submit=${this.handleSend}
            @composer-stop=${this.handleStop}
          ></chat-composer>
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
