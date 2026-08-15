import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
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
import { MessageActionsController } from "../controllers/message-actions-controller.js";
import { longPress } from "../directives/long-press.js";
import { getToolRenderer } from "./tools/index.js";
import { openImageViewerEvent } from "./events.js";
import "./markdown-content.js";

@customElement("chat-message")
export class ChatMessage extends LitElement {
  @property({ attribute: false }) message: Message | null = null;
  @property() sessionId = "";

  @state() private summaryExpanded = false;

  private readonly actions = new MessageActionsController(this);

  override createRenderRoot() {
    return this;
  }

  /** Dismiss transient message-local actions when the conversation scrolls. */
  closeActions(): void {
    this.actions.close();
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
    const actions = this.actions.for(message);

    return html`
      <div
        ${actions.enabled ? longPress({
          feedback: "[data-role=message-press-target]",
          onComplete: actions.openSheet,
        }) : nothing}
        data-role="user-message-row"
        data-message-actions=${actions.enabled ? "true" : nothing}
        class="flex justify-end mb-3 rounded-2xl outline-none md:select-text ${actions.enabled ? 'select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-blue-400/70' : ''}"
        tabindex=${actions.enabled ? "0" : nothing}
        aria-label=${actions.enabled ? "User message. Press Shift+F10 for actions" : nothing}
        @contextmenu=${actions.enabled ? actions.handleContextMenu : nothing}
        @keydown=${actions.enabled ? actions.handleKeyDown : nothing}
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
        ${actions.render()}
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
    const actions = this.actions.for(message);

    return html`
      <div
        ${actions.enabled ? longPress({
          feedback: "[data-role=message-press-target]",
          onComplete: actions.openSheet,
        }) : nothing}
        data-message-actions=${actions.enabled ? "true" : nothing}
        class="relative mb-3 rounded-2xl outline-none md:select-text ${actions.enabled ? 'select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-blue-400/70' : ''}"
        tabindex=${actions.enabled ? "0" : nothing}
        aria-label=${actions.enabled ? "Assistant message. Press Shift+F10 for actions" : nothing}
        @contextmenu=${actions.enabled ? actions.handleContextMenu : nothing}
        @keydown=${actions.enabled ? actions.handleKeyDown : nothing}
      >
        <div data-role="message-press-target" class="flex w-full max-w-full origin-left flex-col items-stretch">
          ${parts}
        </div>
        ${actions.render({ directCopy: true })}
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
