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
import type { ProjectStore } from "../models/stores/project-store.js";
import "./markdown-content.js";
import "./session-model-picker.js";
import "./chat-composer.js";
import { getToolRenderer } from "./tools/index.js";
import {
  applyChatEvent,
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
import type { ChatComposer, ChatComposerSubmitDetail, SendAnimationOrigin, SendAnimationRect } from "./chat-composer.js";
import { openImageViewerEvent } from "./events.js";

export interface ConversationShiftSnapshotItem {
  key: string;
  left: number;
  top: number;
}

export interface ConversationShiftDelta {
  key: string;
  dx: number;
  dy: number;
}

export interface SendAnimationGeometry {
  startLeft: number;
  startTop: number;
  startWidth: number;
  startHeight: number;
  targetLeft: number;
  targetTop: number;
  dx: number;
  dy: number;
}

export interface SendAnimationStages {
  finalDx: number;
  finalDy: number;
  scale: number;
  durationMs: number;
}

export function computeConversationShiftDeltas(
  before: ConversationShiftSnapshotItem[],
  after: ConversationShiftSnapshotItem[],
): ConversationShiftDelta[] {
  const afterByKey = new Map(after.map((item) => [item.key, item]));
  const deltas: ConversationShiftDelta[] = [];

  for (const item of before) {
    const next = afterByKey.get(item.key);
    if (!next) continue;

    const dx = item.left - next.left;
    const dy = item.top - next.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;

    deltas.push({ key: item.key, dx, dy });
  }

  return deltas;
}

export function computeSendAnimationStages(delta: { dx: number; dy: number }): SendAnimationStages {
  return {
    finalDx: delta.dx,
    finalDy: delta.dy,
    scale: 1,
    durationMs: 220,
  };
}

export function computeSendAnimationGeometry(
  originRect: SendAnimationRect,
  targetRect: SendAnimationRect,
  layerRect: SendAnimationRect,
): SendAnimationGeometry {
  const startWidth = Math.min(originRect.width, targetRect.width);
  const startHeight = Math.min(originRect.height, targetRect.height);
  const startLeft = originRect.left - layerRect.left;
  const startTop = originRect.top + ((originRect.height - startHeight) / 2) - layerRect.top;
  const targetLeft = targetRect.left - layerRect.left;
  const targetTop = targetRect.top - layerRect.top;

  return {
    startLeft,
    startTop,
    startWidth,
    startHeight,
    targetLeft,
    targetTop,
    dx: targetLeft - startLeft,
    dy: targetTop - startTop,
  };
}

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

  @state() private messages: AgentMessage[] = [];
  @state() private isStreaming = false;
  @state() private streamingBlocks: StreamingBlock[] = [];
  @state() private expandedSections = new Set<string>();
  @state() private isCompacting = false;
  @state() private errorMessage = "";
  @state() private animatingUserMessageKeys = new Set<string>();

  private errorTimeout?: ReturnType<typeof setTimeout>;

  @query("chat-composer") private composer?: ChatComposer;

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
    // Autofocus the composer when returning to chat tab (desktop only).
    // Session switches remount the component via keyed(sessionId).
    if (changed.has("visible") && this.visible) {
      this.focusInput();
    }

    // Auto-scroll after render
    this.autoScroll();
  }

  /** Focus the chat composer, skipping on touch devices to avoid keyboard popup. */
  private focusInput() {
    if ("ontouchstart" in window || navigator.maxTouchPoints > 0) return;
    requestAnimationFrame(() => this.composer?.focusInput());
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
    // (task_updated, session_created, ws_ack, etc.) are ignored by this component.
    if (event.type === "ws_error") {
      this.showError(event.error || "Something went wrong");
      return;
    }
    if (
      event.type === "task_updated"
      || event.type === "session_created"
      || event.type === "session_updated"
      || event.type === "open_file"
      || event.type === "ws_ack"
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

  private handleSend(e: CustomEvent<ChatComposerSubmitDetail>) {
    const content = e.detail.content;
    const sessionId = this.store?.sessionId ?? "";
    if (!sessionId || !this.store) return;

    const animationOrigin = this.composer?.getSendAnimationOrigin() ?? null;
    const shouldAnimate = animationOrigin !== null && this.canAnimateOutgoingMessage();
    const timestamp = Date.now();
    const messageKey = this.userMessageKey(timestamp);

    const wasStreaming = this.isStreaming;
    const sent = wasStreaming
      ? this.store.steer(content)
      : this.store.prompt(content);
    if (!sent) return;

    const conversationShiftSnapshot = shouldAnimate
      ? this.captureConversationShiftSnapshot()
      : [];

    if (!wasStreaming) {
      // Mirror the imminent agent_start locally so the outgoing bubble's
      // measured target already includes the Thinking row. Otherwise the
      // row can appear mid-flight and push the hidden real bubble upward,
      // producing a jump when the animation reveals it.
      this.isStreaming = true;
      this.streamingBlocks = [];
    }

    if (shouldAnimate) {
      this.animatingUserMessageKeys = new Set([...this.animatingUserMessageKeys, messageKey]);
    }

    this.messages = [
      ...this.messages,
      {
        role: "user",
        content,
        timestamp,
      },
    ];

    this.shouldAutoScroll = true;
    this.composer?.closeSuggestions();
    if (shouldAnimate) {
      void this.runConversationShiftAnimation(conversationShiftSnapshot);
      void this.runOutgoingMessageAnimation(messageKey, animationOrigin);
    }
  }

  private handleStop() {
    this.store?.abort();
  }

  private handleScroll(e: Event) {
    if (!(e.target instanceof HTMLElement)) return;
    const atBottom = e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight < 50;
    this.shouldAutoScroll = atBottom;
  }

  private handleMessageTouchMove() {
    this.composer?.blurInput();
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

  private userMessageKey(timestamp: number): string {
    return `user-${timestamp}`;
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

  private cssEscape(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return value.replace(/["\\]/g, "\\$&");
  }

  private canAnimateOutgoingMessage(): boolean {
    if (typeof document === "undefined" || !document.body) return false;
    if (
      typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return false;
    }
    return true;
  }

  private waitForAnimationFrame(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof globalThis.requestAnimationFrame === "function") {
        globalThis.requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(resolve, 0);
    });
  }

  private revealOutgoingMessage(messageKey: string) {
    if (!this.animatingUserMessageKeys.has(messageKey)) return;
    const next = new Set(this.animatingUserMessageKeys);
    next.delete(messageKey);
    this.animatingUserMessageKeys = next;
  }

  private waitForTransition(element: HTMLElement, durationMs: number): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        element.removeEventListener("transitionend", onTransitionEnd);
        resolve();
      };
      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.target === element && event.propertyName === "transform") finish();
      };
      const timeout = setTimeout(finish, durationMs + 120);
      element.addEventListener("transitionend", onTransitionEnd);
    });
  }

  private captureConversationShiftSnapshot(onlyVisible = true): ConversationShiftSnapshotItem[] {
    if (typeof this.querySelector !== "function" || typeof this.querySelectorAll !== "function") return [];

    const container = this.querySelector<HTMLElement>("#chat-scroll");
    if (!container) return [];

    const containerRect = container.getBoundingClientRect();
    const items: ConversationShiftSnapshotItem[] = [];
    const elements = this.querySelectorAll<HTMLElement>("[data-conversation-key]");

    for (const element of elements) {
      const key = element.dataset.conversationKey;
      if (!key) continue;

      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (onlyVisible && (rect.bottom < containerRect.top || rect.top > containerRect.bottom)) continue;

      items.push({ key, left: rect.left, top: rect.top });
    }

    return items;
  }

  private async runConversationShiftAnimation(before: ConversationShiftSnapshotItem[]): Promise<void> {
    if (before.length === 0) return;

    const animated: Array<{
      element: HTMLElement;
      transition: string;
      transform: string;
      willChange: string;
    }> = [];

    try {
      await this.updateComplete;
      await this.waitForAnimationFrame();

      if (!this.canAnimateOutgoingMessage()) return;

      const after = this.captureConversationShiftSnapshot(false);
      const deltas = computeConversationShiftDeltas(before, after);
      if (deltas.length === 0) return;

      if (typeof this.querySelectorAll !== "function") return;

      const elementsByKey = new Map<string, HTMLElement>();
      for (const element of this.querySelectorAll<HTMLElement>("[data-conversation-key]")) {
        const key = element.dataset.conversationKey;
        if (key) elementsByKey.set(key, element);
      }

      for (const delta of deltas) {
        const element = elementsByKey.get(delta.key);
        if (!element) continue;

        const transform = element.style.transform;
        const baseTransform = transform && transform !== "none" ? transform : "";
        animated.push({
          element,
          transition: element.style.transition,
          transform,
          willChange: element.style.willChange,
        });

        element.classList.add("conversation-shift-animating");
        element.style.transition = "none";
        element.style.transform = `translate3d(${delta.dx}px, ${delta.dy}px, 0)${baseTransform ? ` ${baseTransform}` : ""}`;
        element.style.willChange = "transform";
      }

      if (animated.length === 0) return;

      await this.waitForAnimationFrame();

      const durationMs = 220;
      const easing = "cubic-bezier(0.16, 1, 0.3, 1)";
      for (const item of animated) {
        item.element.style.transition = `transform ${durationMs}ms ${easing}`;
        item.element.style.transform = item.transform;
      }

      await Promise.all(animated.map((item) => this.waitForTransition(item.element, durationMs)));
    } finally {
      for (const item of animated) {
        item.element.classList.remove("conversation-shift-animating");
        item.element.style.transition = item.transition;
        item.element.style.transform = item.transform;
        item.element.style.willChange = item.willChange;
      }
    }
  }

  private async runOutgoingMessageAnimation(
    messageKey: string,
    origin: SendAnimationOrigin,
  ): Promise<void> {
    let ghost: HTMLElement | null = null;

    try {
      await this.updateComplete;
      await this.waitForAnimationFrame();

      if (!this.canAnimateOutgoingMessage()) return;

      const target = this.querySelector<HTMLElement>(
        `[data-message-key="${this.cssEscape(messageKey)}"] [data-role="user-message-bubble"]`,
      );
      if (!target) return;

      const targetRect = target.getBoundingClientRect();
      if (targetRect.width <= 0 || targetRect.height <= 0) return;

      const layer = this.querySelector<HTMLElement>('[data-role="send-animation-layer"]');
      if (!layer) return;
      const layerRect = layer.getBoundingClientRect();
      const geometry = computeSendAnimationGeometry(origin.rect, targetRect, layerRect);

      const targetStyle = typeof globalThis.getComputedStyle === "function"
        ? globalThis.getComputedStyle(target)
        : null;
      const targetBackground = targetStyle?.backgroundColor || "rgb(37, 99, 235)";
      const targetBorderRadius = targetStyle?.borderRadius || "16px";

      const clonedTarget = target.cloneNode(true);
      if (!(clonedTarget instanceof HTMLElement)) return;
      ghost = clonedTarget;
      ghost.classList.add("sent-message-ghost");
      ghost.style.position = "absolute";
      ghost.style.left = `${geometry.startLeft}px`;
      ghost.style.top = `${geometry.startTop}px`;
      ghost.style.width = `${geometry.startWidth}px`;
      ghost.style.height = `${geometry.startHeight}px`;
      ghost.style.maxWidth = "none";
      ghost.style.overflow = "hidden";
      ghost.style.boxSizing = "border-box";
      ghost.style.margin = "0";
      ghost.style.pointerEvents = "none";
      ghost.style.zIndex = "var(--layer-overlay)";
      ghost.style.transformOrigin = "top left";
      ghost.style.transform = "translate3d(0, 0, 0) scale(0.995)";
      ghost.style.backgroundColor = origin.backgroundColor;
      ghost.style.borderRadius = origin.borderRadius;
      ghost.style.opacity = "0.96";
      ghost.style.boxShadow = "0 0 0 rgba(0, 0, 0, 0)";
      ghost.style.willChange = "transform, width, height, opacity";
      ghost.style.contain = "layout paint";
      layer.appendChild(ghost);

      await this.waitForAnimationFrame();
      ghost.getBoundingClientRect();

      const stages = computeSendAnimationStages(geometry);
      const travelEasing = "cubic-bezier(0.16, 1, 0.3, 1)";

      ghost.style.transition = [
        `transform ${stages.durationMs}ms ${travelEasing}`,
        `width ${stages.durationMs}ms ${travelEasing}`,
        `height ${stages.durationMs}ms ${travelEasing}`,
        `background-color ${stages.durationMs}ms ease-out`,
        `border-radius ${stages.durationMs}ms ${travelEasing}`,
        `opacity ${stages.durationMs}ms ease-out`,
      ].join(", ");
      ghost.style.transform = `translate3d(${stages.finalDx}px, ${stages.finalDy}px, 0) scale(${stages.scale})`;
      ghost.style.width = `${targetRect.width}px`;
      ghost.style.height = `${targetRect.height}px`;
      ghost.style.backgroundColor = targetBackground;
      ghost.style.borderRadius = targetBorderRadius;
      ghost.style.opacity = "1";

      await this.waitForTransition(ghost, stages.durationMs);
    } finally {
      this.revealOutgoingMessage(messageKey);
      await this.updateComplete.catch(() => undefined);
      ghost?.remove();
    }
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

  private renderUserMessage(msg: UserMessage) {
    const text = typeof msg.content === "string"
      ? msg.content
      : textFromClientContent(msg.content);
    const images = imagesFromContent(msg.content);
    const sessionId = this.store?.sessionId ?? "";
    const messageKey = this.userMessageKey(msg.timestamp);
    const isAnimating = this.animatingUserMessageKeys.has(messageKey);

    return html`
      <div
        data-role="user-message-row"
        data-message-key=${messageKey}
        data-conversation-key=${messageKey}
        class="flex justify-end mb-3 ${isAnimating ? 'sent-message-target-hidden' : ''}"
      >
        <div class="flex max-w-[80%] flex-col items-end gap-2">
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
      <div data-conversation-key=${this.conversationMessageKey(msg)} class="mb-3">
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

  private renderCompactionSummary(msg: CompactionSummaryMessage) {
    const rawSummary = msg.content || msg.summary;
    const summary = rawSummary && rawSummary !== "Conversation summarized" ? rawSummary : null;
    const id = `compaction-${msg.timestamp || 0}`;
    const expanded = this.expandedSections.has(id);

    return html`
      <div data-conversation-key=${this.conversationMessageKey(msg)} class="my-4">
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
      <div data-conversation-key="streaming-content" class="mb-3 space-y-2">
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
          class="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-1"
          @scroll=${this.handleScroll}
          @touchmove=${this.handleMessageTouchMove}
        >
          ${this.messages.length === 0 && !this.isStreaming && !this.isCompacting ? html`
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
          <chat-composer
            .projectStore=${this.projectStore}
            .sessionId=${sessionId}
            .streaming=${this.isStreaming}
            @composer-submit=${this.handleSend}
            @composer-stop=${this.handleStop}
          ></chat-composer>
        </div>

        <div
          data-role="send-animation-layer"
          class="absolute inset-0 pointer-events-none overflow-visible z-[var(--layer-overlay)]"
          aria-hidden="true"
        ></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-panel": ChatPanel;
  }
}
