import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { createRef, ref, type Ref } from "lit/directives/ref.js";
import { copyTextToClipboard } from "../helpers/clipboard.js";
import type { MessageActionMenuElement } from "../components/message-action-menu.js";
import { checkIcon, copyIcon } from "../components/icons.js";
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
    if (window.matchMedia("(pointer: coarse)").matches) {
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
    if (!(anchor instanceof HTMLElement)) return;
    const rect = anchor.getBoundingClientRect();
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
        ${this.copied
          ? checkIcon("h-3.5 w-3.5 text-green-400")
          : copyIcon("h-3.5 w-3.5")}
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
