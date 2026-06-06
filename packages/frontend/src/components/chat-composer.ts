import { LitElement, html, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { ProjectStore } from "../models/stores/project-store.js";
import {
  normalizeImageSizeHint,
  type AttachmentInfo,
  type ClientPromptContent,
  type ImageAttachmentBlock,
} from "../models/chat-content.js";
import "./skill-suggest.js";
import type { SendAnimationOrigin } from "../helpers/chat-send-animation.js";
import type { SkillInsertDetail, SkillSuggest } from "./skill-suggest.js";

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const IMAGE_ATTACHMENT_ERROR = "Only PNG, JPEG, WebP, and GIF images can be attached.";
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
const MAX_TEXTAREA_HEIGHT = 200;

export interface DraftAttachment {
  id: string;
  file: File;
  objectUrl: string;
  byteSize: number;
  mimeType: string;
  filename: string;
}

export type ChatAttachmentUploader = (attachments: readonly DraftAttachment[]) => Promise<AttachmentInfo[]>;

interface SkillTokenRange {
  start: number;
  end: number;
}

export interface ChatComposerSubmitDetail {
  content: ClientPromptContent;
}

export function imageMimeTypeForFile(file: File): string | null {
  const browserType = file.type.toLowerCase();
  if (ALLOWED_IMAGE_TYPES.has(browserType)) return browserType;

  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}

export function isAllowedImageFile(file: File): boolean {
  return imageMimeTypeForFile(file) !== null;
}

/**
 * If the caret sits inside a `/name` skill token (at the start of the input
 * or immediately after whitespace), return the token's range in `text` and
 * the partial name typed so far. Returns `null` if no completable token is
 * under the caret.
 */
export function findSkillTokenAt(
  text: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  let start = -1;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "/") { start = i; break; }
    if (!/[a-z0-9-]/i.test(ch)) return null;
  }
  if (start === -1) return null;

  const prev = start === 0 ? "" : text[start - 1];
  if (prev !== "" && !/\s/.test(prev)) return null;

  const partial = text.slice(start + 1, caret);
  if (!/^[a-z0-9-]*$/i.test(partial)) return null;

  return { start, end: start + 1 + partial.length, query: partial };
}

export function buildClientPromptContent(
  text: string,
  attachments: AttachmentInfo[],
): ClientPromptContent {
  const trimmed = text.trim();
  const blocks: ClientPromptContent = trimmed ? [{ type: "text", text: trimmed }] : [];

  blocks.push(...attachments.map((attachment): ImageAttachmentBlock => {
    const hint = normalizeImageSizeHint(attachment.width, attachment.height);
    return {
      type: "image",
      attachmentId: attachment.id,
      mimeType: attachment.mimeType,
      filename: attachment.filename,
      byteSize: attachment.byteSize,
      sha256: attachment.sha256,
      ...(hint ? { width: hint.width, height: hint.height } : {}),
    };
  }));

  return blocks;
}

@customElement("chat-composer")
export class ChatComposer extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) projectStore: ProjectStore | null = null;
  @property({ attribute: false }) uploadAttachments: ChatAttachmentUploader | null = null;
  @property({ type: String }) sessionId = "";
  @property({ type: Boolean }) streaming = false;

  @state() private inputText = "";
  @state() private draftAttachments: DraftAttachment[] = [];
  @state() private dragActive = false;
  @state() private isUploading = false;
  @state() private errorMessage = "";

  @query("textarea") private textarea?: HTMLTextAreaElement;
  @query("input[type=file]") private fileInput?: HTMLInputElement;
  @query("skill-suggest") private skillSuggest?: SkillSuggest;
  @query('[data-role="prompt-box"]') private promptBox?: HTMLElement;

  private skillTokenRange: SkillTokenRange | null = null;
  private sendPointerPreservedFocus = false;
  private skipNextSendClick = false;
  private focusPreservationVersion = 0;

  override disconnectedCallback() {
    super.disconnectedCallback();
    for (const attachment of this.draftAttachments) URL.revokeObjectURL(attachment.objectUrl);
  }

  override firstUpdated() {
    this.syncTextareaHeight();
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("inputText")) this.syncTextareaHeight();
  }

  focusInput() {
    requestAnimationFrame(() => this.textarea?.focus({ preventScroll: true }));
  }

  blurInput() {
    if (!this.textarea) return false;
    this.textarea.blur();
    this.focusPreservationVersion += 1;
    this.skillSuggest?.close();
    return true;
  }

  closeSuggestions() {
    this.skillSuggest?.close();
  }

  getSendAnimationOrigin(): SendAnimationOrigin | null {
    const source = this.promptBox;
    if (!source) return null;

    const rect = source.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    let backgroundColor = "rgb(39, 39, 42)";
    let borderRadius = "12px";
    if (typeof globalThis.getComputedStyle === "function") {
      const style = globalThis.getComputedStyle(source);
      backgroundColor = style.backgroundColor || backgroundColor;
      borderRadius = style.borderRadius || borderRadius;
    }

    return {
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      backgroundColor,
      borderRadius,
    };
  }

  private get canSubmit(): boolean {
    return !!this.sessionId
      && !this.isUploading
      && (this.inputText.trim().length > 0 || this.draftAttachments.length > 0);
  }

  private addFiles(files: Iterable<File>) {
    const next: DraftAttachment[] = [];
    let rejected = 0;

    for (const file of files) {
      const mimeType = imageMimeTypeForFile(file);
      if (!mimeType) {
        rejected += 1;
        continue;
      }
      next.push({
        id: globalThis.crypto.randomUUID(),
        file,
        objectUrl: URL.createObjectURL(file),
        byteSize: file.size,
        mimeType,
        filename: file.name || "image",
      });
    }

    if (rejected > 0) this.errorMessage = IMAGE_ATTACHMENT_ERROR;
    if (next.length > 0) {
      this.errorMessage = "";
      this.draftAttachments = [...this.draftAttachments, ...next];
    }
  }

  private removeAttachment(id: string) {
    const attachment = this.draftAttachments.find((item) => item.id === id);
    if (attachment) URL.revokeObjectURL(attachment.objectUrl);
    this.draftAttachments = this.draftAttachments.filter((item) => item.id !== id);
  }

  private clearDraft() {
    for (const attachment of this.draftAttachments) URL.revokeObjectURL(attachment.objectUrl);
    this.draftAttachments = [];
    this.inputText = "";
    this.skillTokenRange = null;
    this.skillSuggest?.close();
    this.errorMessage = "";
  }

  private async uploadDraftAttachments(attachments: readonly DraftAttachment[]): Promise<AttachmentInfo[]> {
    if (attachments.length === 0) return [];
    if (!this.uploadAttachments) throw new Error("Attachment uploads are unavailable");
    return this.uploadAttachments(attachments);
  }

  private async handleSend(opts: { preserveFocus?: boolean } = {}) {
    if (!this.canSubmit) return;

    const focusPreservationVersion = this.focusPreservationVersion;
    if (opts.preserveFocus) this.textarea?.focus({ preventScroll: true });

    this.isUploading = true;
    this.errorMessage = "";
    try {
      let uploaded: AttachmentInfo[];
      try {
        uploaded = await this.uploadDraftAttachments(this.draftAttachments);
      } catch (err) {
        this.errorMessage = err instanceof Error ? err.message : "Failed to send message";
        return;
      }

      const content = buildClientPromptContent(this.inputText, uploaded);
      this.dispatchEvent(new CustomEvent<ChatComposerSubmitDetail>("composer-submit", {
        bubbles: true,
        composed: true,
        detail: { content },
      }));
      this.clearDraft();
      if (opts.preserveFocus && focusPreservationVersion === this.focusPreservationVersion) {
        queueMicrotask(() => this.textarea?.focus({ preventScroll: true }));
      }
    } finally {
      this.isUploading = false;
    }
  }

  private textareaHasFocus(): boolean {
    return typeof document !== "undefined" && document.activeElement === this.textarea;
  }

  private preserveTextareaFocus(e: Event) {
    if (!this.textareaHasFocus()) return;
    e.preventDefault();
    this.textarea?.focus({ preventScroll: true });
  }

  private handleSendPointerDown(e: PointerEvent) {
    this.sendPointerPreservedFocus = false;
    if (!this.textareaHasFocus()) return;
    e.preventDefault();
    this.sendPointerPreservedFocus = true;
    this.textarea?.focus({ preventScroll: true });
  }

  private pointerEndedInsideControl(e: PointerEvent): boolean {
    if (!(e.currentTarget instanceof HTMLElement)) return false;
    if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return true;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    return hit === e.currentTarget || (hit !== null && e.currentTarget.contains(hit));
  }

  private handleSendPointerUp(e: PointerEvent) {
    if (!this.sendPointerPreservedFocus) return;
    this.sendPointerPreservedFocus = false;
    if (!this.pointerEndedInsideControl(e)) return;

    this.skipNextSendClick = true;
    this.textarea?.focus({ preventScroll: true });
    void this.handleSend({ preserveFocus: true });
  }

  private handleSendClick() {
    if (this.skipNextSendClick) {
      this.skipNextSendClick = false;
      return;
    }
    this.textarea?.focus({ preventScroll: true });
    void this.handleSend({ preserveFocus: true });
  }

  private handleStop() {
    this.dispatchEvent(new CustomEvent("composer-stop", { bubbles: true, composed: true }));
  }

  private handleInput(e: Event) {
    if (!(e.target instanceof HTMLTextAreaElement)) return;
    this.inputText = e.target.value;
    const caret = e.target.selectionStart ?? this.inputText.length;

    const token = findSkillTokenAt(this.inputText, caret);
    if (token === null) {
      this.skillTokenRange = null;
      this.skillSuggest?.search(null);
      return;
    }
    this.skillTokenRange = { start: token.start, end: token.end };
    this.skillSuggest?.search(token.query);
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (this.skillSuggest?.handleKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void this.handleSend();
    }
  }

  private handleSkillInsert(e: CustomEvent<SkillInsertDetail>) {
    const range = this.skillTokenRange;
    if (!range) return;
    const insertion = `/${e.detail.name} `;
    const before = this.inputText.slice(0, range.start);
    const after = this.inputText.slice(range.end);
    this.inputText = before + insertion + after;
    const caret = range.start + insertion.length;
    this.skillTokenRange = null;

    queueMicrotask(() => {
      if (!this.textarea) return;
      this.textarea.focus();
      this.textarea.setSelectionRange(caret, caret);
    });
  }

  private handlePaste(e: ClipboardEvent) {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter(isAllowedImageFile);
    if (images.length === 0) return;
    e.preventDefault();
    this.addFiles(images);
  }

  private handleDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    this.dragActive = true;
  }

  private handleDragLeave(e: DragEvent) {
    if (e.currentTarget !== e.target) return;
    this.dragActive = false;
  }

  private handleDrop(e: DragEvent) {
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    this.dragActive = false;
    this.addFiles(Array.from(e.dataTransfer.files));
  }

  private handleFileChange(e: Event) {
    if (!(e.target instanceof HTMLInputElement) || !e.target.files) return;
    this.addFiles(Array.from(e.target.files));
    e.target.value = "";
  }

  private syncTextareaHeight() {
    const textarea = this.textarea;
    if (!textarea) return;
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  private renderAttachmentPreview(attachment: DraftAttachment) {
    return html`
      <div class="relative group rounded-lg overflow-hidden border border-zinc-700 bg-zinc-900 w-24">
        ${attachment.objectUrl ? html`
          <img src=${attachment.objectUrl} alt=${attachment.filename} class="h-16 w-full object-cover bg-zinc-950" />
        ` : html`
          <div class="h-16 w-full flex items-center justify-center text-zinc-500 bg-zinc-950">Image</div>
        `}
        <button
          class="absolute top-1 right-1 rounded-full bg-black/70 text-white w-5 h-5 text-xs leading-none opacity-90 hover:bg-red-600 cursor-pointer"
          type="button"
          title="Remove attachment"
          @click=${() => this.removeAttachment(attachment.id)}
        >×</button>
        <div class="px-1.5 py-1 text-[10px] leading-tight text-zinc-400">
          <div class="truncate" title=${attachment.filename}>${attachment.filename}</div>
          <div>${this.formatSize(attachment.byteSize)}</div>
        </div>
      </div>
    `;
  }

  override render() {
    return html`
      <div
        class="relative"
        @dragover=${this.handleDragOver}
        @dragleave=${this.handleDragLeave}
        @drop=${this.handleDrop}
      >
        <skill-suggest
          .store=${this.projectStore}
          @skill-insert=${this.handleSkillInsert}
        ></skill-suggest>

        ${this.dragActive ? html`
          <div class="absolute inset-0 z-10 rounded-xl border-2 border-dashed border-blue-400 bg-blue-500/10 flex items-center justify-center text-sm text-blue-200 pointer-events-none">
            Drop images to attach
          </div>
        ` : nothing}

        ${this.errorMessage ? html`
          <div class="mb-2 flex items-center gap-2 px-3 py-1.5 bg-red-900/30 border border-red-800/50 rounded-lg text-xs text-red-300">
            <span class="flex-1">${this.errorMessage}</span>
            <button class="text-red-400 hover:text-red-200 cursor-pointer" type="button" @click=${() => { this.errorMessage = ""; }}>✕</button>
          </div>
        ` : nothing}

        ${this.draftAttachments.length > 0 ? html`
          <div class="mb-2 flex gap-2 overflow-x-auto pb-1">
            ${this.draftAttachments.map((attachment) => this.renderAttachmentPreview(attachment))}
          </div>
        ` : nothing}

        <div class="flex items-end gap-2">
          <input
            type="file"
            accept=${IMAGE_ATTACHMENT_ACCEPT}
            multiple
            class="hidden"
            @change=${this.handleFileChange}
          />
          <button
            data-role="attach-control"
            class="shrink-0 h-10 w-10 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-300 text-lg leading-none flex items-center justify-center hover:text-white hover:bg-zinc-700 hover:border-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            type="button"
            title="Attach image"
            aria-label="Attach image"
            ?disabled=${this.isUploading || !this.sessionId}
            @click=${() => this.fileInput?.click()}
          >＋</button>
          <div
            data-role="prompt-box"
            class="flex flex-1 min-w-0 gap-1 items-end rounded-xl bg-zinc-800 border border-zinc-700 px-1 py-1 focus-within:border-blue-500/80 focus-within:ring-1 focus-within:ring-blue-500/60"
          >
            <textarea
              class="min-h-8 max-h-[200px] flex-1 min-w-0 bg-transparent text-zinc-100 px-1 py-1 text-base resize-none outline-none placeholder-zinc-500 leading-6"
              rows="1"
              placeholder=${this.streaming ? "Send a steering message..." : "Type a message..."}
              .value=${this.inputText}
              @input=${this.handleInput}
              @keydown=${this.handleKeyDown}
              @paste=${this.handlePaste}
              @blur=${() => setTimeout(() => this.skillSuggest?.close(), 100)}
            ></textarea>
            ${this.streaming ? html`
              <button
                class="shrink-0 px-3 h-8 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer"
                type="button"
                @click=${this.handleStop}
              >Stop</button>
            ` : nothing}
            <button
              data-role="send-control"
              class="shrink-0 h-8 w-8 flex items-center justify-center bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              type="button"
              title="Send message"
              aria-label="Send message"
              ?disabled=${!this.canSubmit}
              @pointerdown=${this.handleSendPointerDown}
              @pointerup=${this.handleSendPointerUp}
              @mousedown=${this.preserveTextareaFocus}
              @click=${this.handleSendClick}
            >${this.isUploading ? html`
              <span
                data-role="send-icon"
                class="inline-block h-4 w-4 rounded-full border-2 border-white/80 border-t-transparent animate-spin"
                aria-hidden="true"
              ></span>
            ` : html`
              <svg
                data-role="send-icon"
                class="h-4 w-4"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden="true"
              >
                <path
                  fill-rule="evenodd"
                  d="M10 17a.75.75 0 0 1-.75-.75V5.56L5.53 9.28a.75.75 0 0 1-1.06-1.06l5-5a.75.75 0 0 1 1.06 0l5 5a.75.75 0 0 1-1.06 1.06l-3.72-3.72v10.69A.75.75 0 0 1 10 17Z"
                  clip-rule="evenodd"
                />
              </svg>
            `}</button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-composer": ChatComposer;
  }
}
