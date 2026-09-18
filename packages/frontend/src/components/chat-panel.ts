/**
 * Conversation-level chat orchestration. Individual display messages render and
 * own their actions in <chat-message>.
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { ActiveSessionStore } from "../models/stores/active-session-store.js";
import type { ProjectStore } from "../models/stores/project-store.js";
import type { CachedSession } from "../models/stores/session-cache.js";
import type { Message } from "../models/message.js";
import { sessionHash } from "../models/router.js";
import type { SessionListItem } from "../models/ws-client.js";
import type { ChatComposer } from "./chat-composer.js";
import type { ChatComposerSubmitDetail } from "./events.js";
import type { ChatMessage } from "./chat-message.js";
import { ChatSendAnimator } from "../helpers/chat-send-animation.js";
import { ChatHistoryController } from "../controllers/chat-history-controller.js";
import { ringSpinnerIcon } from "./icons.js";
import "./activity-dot.js";
import "../ui/info-card.js";
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
  @property({ attribute: false }) parentSession: CachedSession | null = null;
  @property({ attribute: false }) runningChildSessions: SessionListItem[] = [];
  @property({ type: Boolean }) visible = false;

  @state() private animatingUserMessageKeys = new Set<string>();
  @state() private resumingPendingOperation = false;
  @state() private pendingOperationError = "";
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
    this.resumingPendingOperation = false;
    this.pendingOperationError = "";
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
    const sourceSession = message.role === "sessionUpdate"
      ? this.projectStore?.getSession(message.sourceSessionId)
      : undefined;
    const sourceSessionTitle = sourceSession?.name || sourceSession?.firstMessage || "";

    return html`
      <chat-message
        class="block ${message.role === 'user' && this.animatingUserMessageKeys.has(message.renderKey) ? 'sent-message-target-hidden' : ''}"
        data-conversation-key=${message.renderKey}
        data-message-key=${message.renderKey}
        .message=${message}
        .sessionId=${this.store?.sessionId ?? ""}
        .sourceSessionTitle=${sourceSessionTitle}
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

  private renderParentNavigation() {
    const parentSessionId = this.store?.sessionData.parentSessionId;
    if (!parentSessionId) return nothing;

    const parent = this.parentSession?.id === parentSessionId ? this.parentSession : null;
    const label = parent?.name || parent?.firstMessage || "Parent session";

    return html`
      <nav
        data-role="parent-session-rail"
        aria-label="Parent session"
        class="absolute inset-x-0 top-0 z-[var(--layer-content)] border-b border-zinc-700/80 bg-zinc-900/95 px-3 py-1.5 shadow-sm backdrop-blur"
      >
        <a
          href="${sessionHash(parentSessionId)}"
          class="group flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-zinc-800/80 focus-visible:bg-zinc-800/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500/70"
        >
          <span aria-hidden="true" class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-500/15 text-sm text-blue-300 transition-colors group-hover:bg-blue-500/25">←</span>
          <span class="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm">
            <span class="shrink-0 font-medium text-zinc-400">Parent:</span>
            <span class="truncate font-medium text-zinc-200">${label}</span>
          </span>
        </a>
      </nav>
    `;
  }

  private async handleResumePendingOperation() {
    if (!this.store || this.resumingPendingOperation) return;
    this.resumingPendingOperation = true;
    this.pendingOperationError = "";
    try {
      await this.store.resumePendingOperation();
    } catch (error) {
      this.pendingOperationError = error instanceof Error ? error.message : "Failed to resume interrupted session";
    } finally {
      this.resumingPendingOperation = false;
    }
  }

  private renderPendingOperation() {
    if (!this.store?.sessionData.pendingOperation || this.isStreaming) return nothing;

    return html`
      <section
        data-role="pending-operation"
        aria-label="Interrupted session"
        class="my-4 flex items-center justify-between gap-4 rounded-lg border border-amber-700/50 bg-amber-950/20 px-3 py-2.5"
      >
        <div class="min-w-0 text-sm">
          <div class="font-medium text-amber-200">This session was interrupted</div>
          <div class="text-xs text-amber-200/60">Its unfinished operation is saved and inactive.</div>
          ${this.pendingOperationError ? html`<div class="mt-1 text-xs text-red-300">${this.pendingOperationError}</div>` : nothing}
        </div>
        <button
          type="button"
          class="shrink-0 rounded-md border border-amber-600/60 bg-amber-900/40 px-3 py-1.5 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-900/70 disabled:cursor-wait disabled:opacity-60"
          ?disabled=${this.resumingPendingOperation}
          @click=${this.handleResumePendingOperation}
        >
          ${this.resumingPendingOperation ? "Resuming…" : "Resume interrupted session"}
        </button>
      </section>
    `;
  }

  private renderRunningChildSessions() {
    if (this.runningChildSessions.length === 0) return nothing;

    return html`
      <section
        data-role="running-child-sessions"
        aria-label="Running child sessions"
        class="mt-4 border-t border-zinc-800/80 pt-3"
      >
        <div class="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
          Running sub-sessions
        </div>
        <div class="divide-y divide-zinc-800/80 overflow-hidden rounded-md border border-zinc-800/80 bg-zinc-950/30">
          ${this.runningChildSessions.map((child) => {
            const label = child.name || child.firstMessage || "Sub-session";
            return html`
              <info-card
                class="block"
                .title=${label}
                href="${sessionHash(child.id)}"
                .primaryLabel=${`Open child session: ${label}`}
                .leading=${html`
                  <activity-dot class="shrink-0" .state=${child.activityState}></activity-dot>
                `}
                .trailing=${html`
                  <span class="text-[10px] text-zinc-500">Running</span>
                `}
              ></info-card>
            `;
          })}
        </div>
      </section>
    `;
  }

  override render() {
    const sessionId = this.store?.sessionId ?? "";
    const sessionData = this.store?.sessionData;
    const hasParentSession = Boolean(sessionData?.parentSessionId);

    return html`
      <div class="relative flex flex-col h-full">
        ${this.renderParentNavigation()}
        <div
          id="chat-scroll"
          class="flex-1 space-y-1 overflow-y-auto overflow-x-hidden px-4 pb-4 [overflow-anchor:none] ${hasParentSession ? "pt-14" : "pt-4"}"
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
          ${this.messages.length === 0 && !this.isStreaming && !this.isCompacting && this.runningChildSessions.length === 0 ? html`
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
          ${this.renderPendingOperation()}
          ${this.renderRunningChildSessions()}
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
