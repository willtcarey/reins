import { LitElement, html, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type {
  AssistantMessage,
  AssistantToolCallBlock,
  CompactionMessage,
  Message,
  UserMessage,
} from "../models/message.js";
import {
  imageAspectRatioStyle,
  imageBlockSrc,
  imagesFromContent,
  imageSizeHint,
  textFromClientContent,
  type ChatImageBlock,
} from "../models/chat-content.js";
import { longPress } from "../directives/long-press.js";
import { copyTextToClipboard } from "../helpers/clipboard.js";
import { getToolRenderer } from "./tools/index.js";
import { openImageViewerEvent } from "./events.js";
import { showToast } from "./toast.js";
import "./markdown-content.js";
import "./message-action-menu.js";
import type { MessageActionMenuElement } from "./message-action-menu.js";

const COPY_FEEDBACK_MS = 700;

@customElement("chat-message")
export class ChatMessage extends LitElement {
  @property({ attribute: false }) message: Message | null = null;
  @property() sessionId = "";

  @state() private copied = false;
  @state() private summaryExpanded = false;
  @query("message-action-menu") private actionMenu?: MessageActionMenuElement;

  private copyFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    this.closeActions();
    this.clearCopyFeedbackTimer();
    super.disconnectedCallback();
  }

  /** Dismiss transient message-local actions when the conversation scrolls. */
  closeActions(): void {
    this.actionMenu?.close();
  }

  private async copyMessage(text: string): Promise<boolean> {
    try {
      await copyTextToClipboard(text);
      return true;
    } catch {
      showToast("Could not copy message", "error");
      return false;
    }
  }

  private async copyDirect(event: Event, message: Message) {
    event.stopPropagation();
    const text = message.copyMarkdown();
    if (!text || !await this.copyMessage(text)) return;

    this.clearCopyFeedbackTimer();
    this.copied = true;
    this.copyFeedbackTimer = setTimeout(() => {
      this.copyFeedbackTimer = null;
      this.copied = false;
    }, COPY_FEEDBACK_MS);
  }

  private openSheet(message: Message): Promise<void> {
    const text = message.copyMarkdown();
    return text ? this.actionMenu?.openSheet(text) ?? Promise.resolve() : Promise.resolve();
  }

  private handleContextMenu(event: MouseEvent, message: Message) {
    const text = message.copyMarkdown();
    if (!text) return;

    event.preventDefault();
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true) {
      void this.actionMenu?.openSheet(text);
      return;
    }
    this.actionMenu?.openContext(text, event.clientX, event.clientY);
  }

  private handleKeyDown(event: KeyboardEvent, message: Message) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    const text = message.copyMarkdown();
    if (!text) return;

    event.preventDefault();
    const anchor = event.currentTarget;
    const rect = typeof Element !== "undefined" && anchor instanceof Element
      ? anchor.getBoundingClientRect()
      : { left: 0, bottom: 0 };
    this.actionMenu?.openContext(text, rect.left, rect.bottom);
  }

  private clearCopyFeedbackTimer() {
    if (this.copyFeedbackTimer !== null) clearTimeout(this.copyFeedbackTimer);
    this.copyFeedbackTimer = null;
  }

  private renderActionMenu() {
    return html`
      <message-action-menu
        .copyMessage=${(text: string) => this.copyMessage(text)}
      ></message-action-menu>
    `;
  }

  private renderDesktopCopyControl(message: Message) {
    return html`
      <button
        data-role="desktop-copy-message"
        type="button"
        class="absolute top-0 right-[10%] z-[var(--layer-content)] hidden h-7 w-7 items-center justify-center rounded-md bg-transparent text-zinc-500 transition-colors hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 md:inline-flex"
        title=${this.copied ? "Copied" : "Copy as Markdown"}
        aria-label="Copy as Markdown"
        @click=${(event: Event) => this.copyDirect(event, message)}
      >
        ${this.copied ? html`
          <svg class="h-4 w-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
        ` : html`
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
        `}
      </button>
    `;
  }

  private renderChatImage(image: ChatImageBlock) {
    const hint = imageSizeHint(image);
    const src = imageBlockSrc(this.sessionId, image);
    const alt = "filename" in image && image.filename ? image.filename : "Attached image";
    const className = "block h-auto w-auto max-h-64 max-w-full rounded-lg border border-zinc-700 bg-zinc-900 transition-opacity group-hover:opacity-90";
    const openImage = (event: Event) => {
      event.stopPropagation();
      this.dispatchEvent(openImageViewerEvent({ src, alt, title: alt }));
    };
    const imageTemplate = !hint
      ? html`<img src=${src} alt=${alt} class=${className} loading="lazy" />`
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

  private renderUser(message: UserMessage) {
    const text = typeof message.raw.content === "string"
      ? message.raw.content
      : textFromClientContent(message.raw.content);
    const images = imagesFromContent(message.raw.content);

    return html`
      <div
        ${message.copyable ? longPress({
          feedback: "[data-role=message-press-target]",
          onComplete: () => this.openSheet(message),
        }) : nothing}
        data-role="user-message-row"
        data-message-actions=${message.copyable ? "true" : nothing}
        class="flex justify-end mb-3 rounded-2xl outline-none md:select-text ${message.copyable ? 'select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-blue-400/70' : ''}"
        tabindex=${message.copyable ? "0" : nothing}
        aria-label=${message.copyable ? "User message. Press Shift+F10 for actions" : nothing}
        @contextmenu=${message.copyable ? (event: MouseEvent) => this.handleContextMenu(event, message) : nothing}
        @keydown=${message.copyable ? (event: KeyboardEvent) => this.handleKeyDown(event, message) : nothing}
      >
        <div data-role="user-message-animation-target" class="flex max-w-[80%] flex-col items-end">
          <div data-role="message-press-target" class="flex max-w-full origin-bottom-right flex-col items-end gap-2">
            ${images.length > 0 ? html`
              <div data-role="user-message-attachments" class="grid grid-cols-1 gap-2 justify-items-end max-w-full">
                ${images.map((image) => this.renderChatImage(image))}
              </div>
            ` : nothing}
            ${text ? html`
              <div data-role="user-message-bubble" class="bg-blue-600 text-white rounded-2xl rounded-br-md px-3 py-1.5 max-w-full text-sm">
                <div class="whitespace-pre-wrap">${text}</div>
              </div>
            ` : nothing}
          </div>
        </div>
        ${this.renderActionMenu()}
      </div>
    `;
  }

  private renderAssistant(message: AssistantMessage) {
    const parts: unknown[] = [];
    const textBuffer: string[] = [];
    const flushText = () => {
      if (textBuffer.length === 0) return;
      const text = textBuffer.join("\n");
      textBuffer.length = 0;
      parts.push(html`
        <div class="bg-zinc-800 border-l-2 border-blue-400/60 rounded-2xl rounded-bl-md px-4 py-2 max-w-[90%] text-sm">
          <markdown-content .text=${text} .streaming=${message.streaming}></markdown-content>
        </div>
      `);
    };

    for (const block of message.blocks) {
      if (block.type === "text") {
        textBuffer.push(block.text);
      } else if (block.type === "toolCall") {
        flushText();
        parts.push(this.renderToolCall(block));
      }
    }
    flushText();

    return html`
      <div
        ${message.copyable ? longPress({
          feedback: "[data-role=message-press-target]",
          onComplete: () => this.openSheet(message),
        }) : nothing}
        data-message-actions=${message.copyable ? "true" : nothing}
        class="relative mb-3 rounded-2xl outline-none md:select-text ${message.copyable ? 'select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-blue-400/70' : ''}"
        tabindex=${message.copyable ? "0" : nothing}
        aria-label=${message.copyable ? "Assistant message. Press Shift+F10 for actions" : nothing}
        @contextmenu=${message.copyable ? (event: MouseEvent) => this.handleContextMenu(event, message) : nothing}
        @keydown=${message.copyable ? (event: KeyboardEvent) => this.handleKeyDown(event, message) : nothing}
      >
        <div data-role="message-press-target" class="flex w-full max-w-full origin-left flex-col items-stretch">
          ${parts}
        </div>
        ${message.copyable ? this.renderDesktopCopyControl(message) : nothing}
        ${this.renderActionMenu()}
      </div>
    `;
  }

  private renderToolCall(toolCall: AssistantToolCallBlock) {
    const block = toolCall.renderData;
    if (!block) return nothing;
    const renderer = getToolRenderer(block.name);
    return html`<div class="max-w-[90%]">${renderer.render({ ...block, sessionId: this.sessionId })}</div>`;
  }

  private renderCompaction(message: CompactionMessage) {
    const rawSummary = message.raw.content || message.raw.summary;
    const summary = rawSummary && rawSummary !== "Conversation summarized" ? rawSummary : null;

    return html`
      <div class="my-4">
        <div class="flex items-center gap-3">
          <div class="flex-1 border-t border-zinc-600"></div>
          <button
            class="flex items-center gap-1.5 text-[10px] text-zinc-500 uppercase tracking-wide shrink-0 ${summary ? 'hover:text-zinc-300 cursor-pointer' : ''} transition-colors"
            @click=${() => { if (summary) this.summaryExpanded = !this.summaryExpanded; }}
            ?disabled=${!summary}
          >
            ${summary ? html`<span class="font-mono">${this.summaryExpanded ? '▼' : '▶'}</span>` : nothing}
            Conversation summarized
          </button>
          <div class="flex-1 border-t border-zinc-600"></div>
        </div>
        ${this.summaryExpanded && summary ? html`
          <div class="mt-2 mx-4 bg-zinc-800/50 rounded-lg px-4 py-3 text-sm border border-zinc-700">
            <markdown-content .text=${summary}></markdown-content>
          </div>
        ` : nothing}
      </div>
    `;
  }

  override render() {
    const message = this.message;
    if (!message) return nothing;

    switch (message.role) {
      case "user":
        return this.renderUser(message);
      case "assistant":
        return this.renderAssistant(message);
      case "compactionSummary":
        return this.renderCompaction(message);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-message": ChatMessage;
  }
}
