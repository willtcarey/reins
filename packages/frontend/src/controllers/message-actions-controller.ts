import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { createRef, ref, type Ref } from "lit/directives/ref.js";
import { copyTextToClipboard } from "../helpers/clipboard.js";
import type { MessageActionMenuElement } from "../components/message-action-menu.js";
import { showToast } from "../components/toast.js";
import "../components/message-action-menu.js";

const COPY_FEEDBACK_MS = 700;

export interface MarkdownCopySource {
  toMarkdown(): string | null;
}

export interface MessageActionRenderOptions {
  directCopy?: boolean;
}

/** Message-specific action binding returned to a rendering caller. */
export class BoundMessageActions {
  readonly enabled: boolean;

  constructor(
    private readonly controller: MessageActionsController,
    private readonly message: MarkdownCopySource,
  ) {
    this.enabled = message.toMarkdown() !== null;
  }

  readonly openSheet = () => this.controller.openSheet(this.message);

  readonly handleContextMenu = (event: MouseEvent) => {
    this.controller.openContextMenu(event, this.message);
  };

  readonly handleKeyDown = (event: KeyboardEvent) => {
    this.controller.openKeyboardMenu(event, this.message);
  };

  render(options: MessageActionRenderOptions = {}) {
    if (!this.enabled) return nothing;
    return this.controller.render(this.message, options);
  }
}

/** Owns clipboard orchestration and transient actions for one chat-message host. */
export class MessageActionsController implements ReactiveController {
  private readonly menuRef: Ref<MessageActionMenuElement> = createRef();
  private copied = false;
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  for(message: MarkdownCopySource): BoundMessageActions {
    return new BoundMessageActions(this, message);
  }

  hostDisconnected() {
    this.close();
  }

  close(): void {
    this.menuRef.value?.close();
    this.clearFeedbackTimer();
    if (this.copied) {
      this.copied = false;
      this.host.requestUpdate();
    }
  }

  openSheet(message: MarkdownCopySource): Promise<void> {
    const text = message.toMarkdown();
    return text ? this.menuRef.value?.openSheet(text) ?? Promise.resolve() : Promise.resolve();
  }

  openContextMenu(event: MouseEvent, message: MarkdownCopySource): void {
    const text = message.toMarkdown();
    if (!text) return;

    event.preventDefault();
    if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true) {
      void this.menuRef.value?.openSheet(text);
      return;
    }
    this.menuRef.value?.openContext(text, event.clientX, event.clientY);
  }

  openKeyboardMenu(event: KeyboardEvent, message: MarkdownCopySource): void {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    const text = message.toMarkdown();
    if (!text) return;

    event.preventDefault();
    const anchor = event.currentTarget;
    const rect = typeof Element !== "undefined" && anchor instanceof Element
      ? anchor.getBoundingClientRect()
      : { left: 0, bottom: 0 };
    this.menuRef.value?.openContext(text, rect.left, rect.bottom);
  }

  render(message: MarkdownCopySource, options: MessageActionRenderOptions) {
    return html`
      ${options.directCopy ? this.renderDirectCopy(message) : nothing}
      <message-action-menu
        ${ref(this.menuRef)}
        .copyMessage=${(text: string) => this.copyText(text)}
      ></message-action-menu>
    `;
  }

  private renderDirectCopy(message: MarkdownCopySource) {
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
          <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true">
            <rect width="14" height="14" x="8" y="8" rx="2"/>
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
          </svg>
        `}
      </button>
    `;
  }

  private async copyDirect(event: Event, message: MarkdownCopySource) {
    event.stopPropagation();
    const text = message.toMarkdown();
    if (!text || !await this.copyText(text)) return;

    this.clearFeedbackTimer();
    this.copied = true;
    this.host.requestUpdate();
    this.feedbackTimer = setTimeout(() => {
      this.feedbackTimer = null;
      this.copied = false;
      this.host.requestUpdate();
    }, COPY_FEEDBACK_MS);
  }

  private async copyText(text: string): Promise<boolean> {
    try {
      await copyTextToClipboard(text);
      return true;
    } catch {
      showToast("Could not copy message", "error");
      return false;
    }
  }

  private clearFeedbackTimer() {
    if (this.feedbackTimer !== null) clearTimeout(this.feedbackTimer);
    this.feedbackTimer = null;
  }
}
