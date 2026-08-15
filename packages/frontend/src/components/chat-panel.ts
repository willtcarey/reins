/**
 * Conversation-level chat orchestration. Individual display messages render and
 * own their actions in <chat-message>.
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { ActiveSessionStore } from "../models/stores/active-session-store.js";
import type { ProjectStore } from "../models/stores/project-store.js";
import type { Message } from "../models/message.js";
import type { ChatComposer, ChatComposerSubmitDetail } from "./chat-composer.js";
import type { ChatMessage } from "./chat-message.js";
import { ChatSendAnimator } from "../helpers/chat-send-animation.js";
import { ChatHistoryController } from "../controllers/chat-history-controller.js";
import { ringSpinnerIcon } from "./icons.js";
import "./chat-message.js";
import "./session-model-picker.js";
import "./chat-composer.js";

@customElement("chat-panel")
export class ChatPanel extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) store: ActiveSessionStore | null = null;
  @property({ attribute: false }) projectStore: ProjectStore | null = null;
  @property({ type: Boolean }) visible = false;

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
    this.closeMessageActions();
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
    this.closeMessageActions();
    this.animatingUserMessageKeys = new Set();
    this.shouldAutoScroll = true;
    this.history.reset();
  }

  private get messages(): Message[] {
    return this.store?.conversation.messages ?? [];
  }

  private get streamingMessages() {
    return this.store?.conversation.streamingMessages ?? [];
  }

  /** SessionCache metadata is the sole frontend owner of runtime activity. */
  private get isStreaming(): boolean {
    return this.store?.sessionData.activityState === "running";
  }

  private get isCompacting(): boolean {
    return this.store?.conversation.isCompacting ?? false;
  }

  private get errorMessage(): string {
    return this.store?.conversation.errorMessage ?? "";
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("visible") && this.visible) this.focusInput();
    this.autoScroll();
    this.sendAnimator.cancelIfTargetMissing();
  }

  private focusInput() {
    if ("ontouchstart" in window || navigator.maxTouchPoints > 0) return;
    requestAnimationFrame(() => this.composer?.focusInput());
  }

  private subscribeToStore() {
    this.unsubscribeStore?.();
    this.unsubscribeStore = this.store?.subscribe(() => this.requestUpdate()) ?? undefined;
  }

  private handleSend(e: CustomEvent<ChatComposerSubmitDetail>) {
    const { content, source } = e.detail;
    const sessionId = this.store?.sessionId ?? "";
    if (!sessionId || !this.store) return;

    const submittedEntry = this.isStreaming
      ? this.store.steer(content)
      : this.store.prompt(content);
    if (!submittedEntry) return;

    const messageKey = submittedEntry.localId;
    const shouldAnimate = source != null && this.sendAnimator.canAnimateOutgoingMessage();
    if (shouldAnimate) {
      this.animatingUserMessageKeys = new Set([...this.animatingUserMessageKeys, messageKey]);
    }

    this.shouldAutoScroll = true;
    this.composer?.closeSuggestions();
    if (shouldAnimate) {
      void this.sendAnimator.animate(messageKey, source, () => this.revealOutgoingMessage(messageKey));
    }
  }

  private handleStop() {
    this.store?.abort();
  }

  private handleScroll(e: Event) {
    if (!(e.target instanceof HTMLElement)) return;
    this.closeMessageActions();
    const atBottom = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 50;
    this.shouldAutoScroll = atBottom;
    this.history.handleScroll(e.target);
  }

  private closeMessageActions() {
    for (const message of this.querySelectorAll<ChatMessage>("chat-message")) message.closeActions();
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
      if (container) container.scrollTop = container.scrollHeight;
    });
  }

  private revealOutgoingMessage(messageKey: string) {
    if (!this.animatingUserMessageKeys.has(messageKey)) return;
    const next = new Set(this.animatingUserMessageKeys);
    next.delete(messageKey);
    this.animatingUserMessageKeys = next;
  }

  private renderMessage(message: Message) {
    return html`
      <chat-message
        class="block ${message.role === 'user' && this.animatingUserMessageKeys.has(message.renderKey) ? 'sent-message-target-hidden' : ''}"
        data-conversation-key=${message.renderKey}
        data-message-key=${message.renderKey}
        .message=${message}
        .sessionId=${this.store?.sessionId ?? ""}
      ></chat-message>
    `;
  }

  private renderCompactingIndicator() {
    return html`
      <div class="flex items-center gap-2 text-sm text-amber-500/80">
        ${ringSpinnerIcon("inline-block w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin flex-shrink-0")}
        Summarizing conversation…
      </div>
    `;
  }

  private renderThinkingIndicator() {
    return html`
      <div class="flex items-center gap-2 text-sm text-zinc-500">
        ${ringSpinnerIcon("inline-block w-3 h-3 border-2 border-zinc-500 border-t-transparent rounded-full animate-spin")}
        Thinking...
      </div>
    `;
  }

  private renderStreamingContent() {
    const hasVisibleAssistantContent = this.streamingMessages.some((message) => message.hasVisibleContent);
    const showThinking = this.isStreaming && !this.isCompacting && !hasVisibleAssistantContent;
    if (!showThinking && this.streamingMessages.length === 0 && !this.isCompacting) return nothing;

    return html`
      <div data-role="streaming-content" data-conversation-key="streaming-content" class="mb-3 space-y-2">
        ${repeat(
          this.streamingMessages,
          (message) => message.renderKey,
          (message) => this.renderMessage(message),
        )}
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
            this.messages,
            (message) => message.renderKey,
            (message) => this.renderMessage(message),
          )}
          ${this.renderStreamingContent()}
        </div>

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
