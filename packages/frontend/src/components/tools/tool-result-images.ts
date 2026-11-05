/**
 * <tool-result-images> — a tool result's images as thumbnails; clicking one opens it full screen
 * (`openImageViewerEvent`). Shared by the tool renderers, so every tool shows images the same way.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { imageBlockSrc, type ChatImageBlock } from "../../models/chat-content.js";
import { openImageViewerEvent } from "../events.js";

const altOf = (image: ChatImageBlock) => "filename" in image && image.filename ? image.filename : "Tool result image";

@customElement("tool-result-images")
export class ToolResultImages extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) images: ChatImageBlock[] = [];
  @property({ attribute: false }) sessionId = "";
  /** The thumbnails' height limit, a Tailwind class (larger in an expanded block). */
  @property({ attribute: false }) maxHeight = "max-h-48";

  private _open(event: Event, image: ChatImageBlock) {
    // The block around it would take the click as a toggle.
    event.stopPropagation();
    const alt = altOf(image);
    this.dispatchEvent(openImageViewerEvent({ src: imageBlockSrc(this.sessionId, image), alt, title: alt }));
  }

  override render() {
    return html`
      <div class="flex flex-wrap gap-2">
        ${this.images.map((image) => html`
          <button
            type="button"
            class="group block max-w-full cursor-zoom-in rounded focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 focus:ring-offset-zinc-950"
            title="Open image full screen"
            @click=${(event: Event) => this._open(event, image)}
          >
            <span class="sr-only">Open image full screen: ${altOf(image)}</span>
            <img src=${imageBlockSrc(this.sessionId, image)} class="max-w-full ${this.maxHeight} rounded transition-opacity group-hover:opacity-90" alt=${altOf(image)} loading="lazy" />
          </button>
        `)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "tool-result-images": ToolResultImages;
  }
}
