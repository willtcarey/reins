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
import { styleMap } from "lit/directives/style-map.js";
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
  type ToolExecution,
  type StreamingAssistant,
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
import { MessageActionsController } from "../controllers/message-actions-controller.js";
import { messageMarkdown } from "../models/message-markdown.js";
import { showToast } from "./toast.js";

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
  private messageActions = new MessageActionsController(this);
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

  /** SessionCache metadata is the sole frontend owner of runtime activity. */
  private get isStreaming(): boolean {
    return this.store?.sessionData.activityState === "running";
  }

  private get streamingAssistants(): StreamingAssistant[] {
    return this.store?.conversation.streamingAssistants ?? [];
  }

  private get isCompacting(): boolean {
    return this.store?.conversation.isCompacting ?? false;
  }

  private get errorMessage(): string {
    return this.store?.conversation.errorMessage ?? "";
  }

  override updated(changed: Map<string, unknown>) {
    const actionMenu = this.querySelector<HTMLElement>("[data-role=message-action-menu]");
    if (
      actionMenu
      && typeof actionMenu.showPopover === "function"
      && !actionMenu.matches(":popover-open")
    ) {
      actionMenu.showPopover();
      actionMenu.querySelector<HTMLElement>("button")?.focus();
    }

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
    if (this.messageActions.menu) this.messageActions.close();
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

  private handleMessagePointerDown(event: PointerEvent, key: string, text: string) {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    this.messageActions.beginTouchPress(key, text, event.clientX, event.clientY);
  }

  private handleMessagePointerMove(event: PointerEvent) {
    if (event.pointerType !== "touch") return;
    this.messageActions.moveTouchPress(event.clientX, event.clientY);
  }

  private handleMessagePointerEnd(event: PointerEvent) {
    if (event.pointerType !== "touch") return;
    this.messageActions.endTouchPress();
  }

  private handleMessageContextMenu(event: MouseEvent, text: string) {
    event.preventDefault();
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches) {
      this.messageActions.openActionSheet(text, event.clientX, event.clientY);
    } else {
      this.messageActions.openContextMenu(text, event.clientX, event.clientY);
    }
  }

  private handleMessageKeydown(event: KeyboardEvent, text: string) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = event.currentTarget instanceof HTMLElement
      ? event.currentTarget.getBoundingClientRect()
      : { left: 0, bottom: 0 };
    this.messageActions.openKeyboardMenu(text, rect);
  }

  private messageActionAttributes(message: UserMessage | AssistantMessage, key: string) {
    const text = messageMarkdown(message);
    if (!text) return null;
    return {
      text,
      pressed: this.messageActions.pressedKey === key,
      copied: this.messageActions.copiedKey === key,
    };
  }

  private async copyMessageDirect(event: Event, key: string, text: string) {
    event.stopPropagation();
    try {
      await this.messageActions.copyDirect(key, text);
    } catch {
      showToast("Could not copy message", "error");
    }
  }

  private renderDesktopCopyControl(key: string, text: string, copied: boolean, positionClass: string) {
    return html`
      <button
        data-role="desktop-copy-message"
        type="button"
        class="absolute top-0 ${positionClass} z-[var(--layer-content)] hidden h-7 w-7 items-center justify-center rounded-md bg-zinc-900/80 text-zinc-500 shadow-sm transition-colors hover:bg-zinc-700 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 md:inline-flex"
        title=${copied ? "Copied" : "Copy as Markdown"}
        aria-label="Copy as Markdown"
        @click=${(event: Event) => this.copyMessageDirect(event, key, text)}
      >
        ${copied ? html`
          <svg class="h-4 w-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
        ` : html`
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
        `}
      </button>
    `;
  }

  private async copyMessageMarkdown() {
    try {
      await this.messageActions.copyMarkdown();
    } catch {
      this.messageActions.close();
      showToast("Could not copy message", "error");
    }
  }

  private renderMessageActionMenu() {
    const menu = this.messageActions.menu;
    if (!menu) return nothing;
    const copied = this.messageActions.copied;
    const menuLeft = typeof window === "undefined"
      ? menu.x
      : Math.max(8, Math.min(menu.x, window.innerWidth - 216));
    const menuTop = typeof window === "undefined"
      ? menu.y
      : Math.max(8, Math.min(menu.y, window.innerHeight - 64));
    const action = html`
      <button
        type="button"
        role=${menu.mode === "menu" ? "menuitem" : nothing}
        class="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium ${copied ? 'text-green-300' : 'text-zinc-100'} active:bg-zinc-700"
        ?disabled=${copied}
        @click=${() => this.copyMessageMarkdown()}
      >
        <span aria-hidden="true">${copied ? "✓" : "⧉"}</span>
        <span aria-live="polite">${copied ? "Copied" : "Copy as Markdown"}</span>
      </button>
    `;

    return html`
      <div
        data-role="message-action-menu"
        popover="manual"
        class="fixed inset-0 m-0 h-[100dvh] max-h-none w-screen max-w-none border-0 ${menu.mode === 'sheet' ? 'bg-black/40' : 'bg-transparent'} p-0 z-[var(--layer-overlay)]"
        role=${menu.mode === "sheet" ? "dialog" : "menu"}
        aria-label="Message actions"
        @click=${() => this.messageActions.close()}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape") this.messageActions.close();
        }}
      >
        ${menu.mode === "sheet" ? html`
          <div class="absolute inset-x-0 bottom-0 p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]" @click=${(event: Event) => event.stopPropagation()}>
            <div class="overflow-hidden rounded-xl border border-zinc-700 bg-zinc-800 shadow-2xl">
              ${action}
            </div>
            <button
              type="button"
              class="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-sm font-semibold text-zinc-200 active:bg-zinc-700"
              @click=${() => this.messageActions.close()}
            >Cancel</button>
          </div>
        ` : html`
          <div
            class="absolute w-52 overflow-hidden rounded-md border border-zinc-600 bg-zinc-800 shadow-xl"
            style=${styleMap({ left: `${menuLeft}px`, top: `${menuTop}px` })}
            @click=${(event: Event) => event.stopPropagation()}
          >
            ${action}
          </div>
        `}
      </div>
    `;
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
    const action = this.messageActionAttributes(msg, messageKey);

    return html`
      <div
        data-role="user-message-row"
        data-message-actions=${action ? "true" : nothing}
        data-message-key=${messageKey}
        data-conversation-key=${conversationKey}
        class="relative flex justify-end mb-3 rounded-2xl outline-none transition-[background,transform] md:select-text ${action ? 'select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-blue-400/70' : ''} ${action?.pressed ? 'scale-[0.99] bg-zinc-700/50' : ''} ${isAnimating ? 'sent-message-target-hidden' : ''}"
        tabindex=${action ? "0" : nothing}
        aria-label=${action ? "User message. Press Shift+F10 for actions" : nothing}
        @pointerdown=${action ? (event: PointerEvent) => this.handleMessagePointerDown(event, messageKey, action.text) : nothing}
        @pointermove=${action ? this.handleMessagePointerMove : nothing}
        @pointerup=${action ? this.handleMessagePointerEnd : nothing}
        @pointercancel=${action ? this.handleMessagePointerEnd : nothing}
        @contextmenu=${action ? (event: MouseEvent) => this.handleMessageContextMenu(event, action.text) : nothing}
        @keydown=${action ? (event: KeyboardEvent) => this.handleMessageKeydown(event, action.text) : nothing}
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
        ${action ? this.renderDesktopCopyControl(messageKey, action.text, action.copied, "right-0") : nothing}
      </div>
    `;
  }

  private renderAssistantMessage(
    msg: AssistantMessage,
    conversationKey = this.conversationMessageKey(msg),
    options: { streaming?: boolean; toolExecutions?: StreamingAssistant["toolExecutions"] } = {},
  ) {
    const parts: unknown[] = [];
    const textBuffer: string[] = [];
    const action = this.messageActionAttributes(msg, conversationKey);

    const flushText = () => {
      if (textBuffer.length === 0) return;
      const text = textBuffer.join("\n");
      textBuffer.length = 0;
      parts.push(html`
        <div class="bg-zinc-800 border-l-2 border-blue-400/60 rounded-2xl rounded-bl-md px-4 py-2 max-w-[90%] text-sm">
          <markdown-content .text=${text} .streaming=${options.streaming ?? false}></markdown-content>
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
        parts.push(this.renderToolCall(block, options));
      }
      // Skip thinking blocks in the UI
    }

    flushText();

    return html`
      <div
        data-conversation-key=${conversationKey}
        data-message-actions=${action ? "true" : nothing}
        class="relative mb-3 rounded-2xl outline-none transition-[background,transform] md:select-text ${action ? 'select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-blue-400/70' : ''} ${action?.pressed ? 'scale-[0.99] bg-zinc-700/50' : ''}"
        tabindex=${action ? "0" : nothing}
        aria-label=${action ? "Assistant message. Press Shift+F10 for actions" : nothing}
        @pointerdown=${action ? (event: PointerEvent) => this.handleMessagePointerDown(event, conversationKey, action.text) : nothing}
        @pointermove=${action ? this.handleMessagePointerMove : nothing}
        @pointerup=${action ? this.handleMessagePointerEnd : nothing}
        @pointercancel=${action ? this.handleMessagePointerEnd : nothing}
        @contextmenu=${action ? (event: MouseEvent) => this.handleMessageContextMenu(event, action.text) : nothing}
        @keydown=${action ? (event: KeyboardEvent) => this.handleMessageKeydown(event, action.text) : nothing}
      >
        ${parts}
        ${action ? this.renderDesktopCopyControl(conversationKey, action.text, action.copied, "right-[10%]") : nothing}
      </div>
    `;
  }

  private renderToolCall(
    tc: ToolCall,
    options: { streaming?: boolean; toolExecutions?: StreamingAssistant["toolExecutions"] } = {},
  ) {
    const execution = options.toolExecutions?.[tc.id];
    if (options.streaming) {
      // Tool-call snapshots contain arguments while they are still being
      // parsed. Wait for execution_start so expensive renderers only receive
      // the finalized arguments rather than re-highlighting every delta.
      return execution ? this.renderToolBlock(execution) : nothing;
    }

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

  private renderToolBlock(block: ToolExecution) {
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
    const hasVisibleAssistantContent = this.streamingAssistants.some(({ message, toolExecutions }) => (
      message.content.some((block) => (
        (block.type === "text" && block.text.length > 0)
        || (block.type === "toolCall" && toolExecutions[block.id] !== undefined)
      ))
    ));
    const showThinking = this.isStreaming && !this.isCompacting && !hasVisibleAssistantContent;
    if (!showThinking && this.streamingAssistants.length === 0 && !this.isCompacting) return nothing;

    return html`
      <div
        data-role="streaming-content"
        data-conversation-key="streaming-content"
        class="mb-3 space-y-2"
      >
        ${this.streamingAssistants.map(({ message, toolExecutions }) => (
          this.renderAssistantMessage(message, `streaming-assistant-${message.timestamp}`, {
            streaming: true,
            toolExecutions,
          })
        ))}
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

        ${this.renderMessageActionMenu()}

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
