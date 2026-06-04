import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { OpenImageViewerDetail } from "./events.js";

export interface FittedImageSizeInput {
  naturalWidth: number;
  naturalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  zoom: number;
}

export interface FittedImageSize {
  width: number;
  height: number;
}

export function computeFittedImageSize(input: FittedImageSizeInput): FittedImageSize {
  const naturalWidth = Number.isFinite(input.naturalWidth) ? input.naturalWidth : 0;
  const naturalHeight = Number.isFinite(input.naturalHeight) ? input.naturalHeight : 0;
  if (naturalWidth <= 0 || naturalHeight <= 0) return { width: 0, height: 0 };

  const viewportWidth = Math.max(1, Number.isFinite(input.viewportWidth) ? input.viewportWidth : 0);
  const viewportHeight = Math.max(1, Number.isFinite(input.viewportHeight) ? input.viewportHeight : 0);
  const zoom = Math.max(0.01, Number.isFinite(input.zoom) ? input.zoom : 1);
  const fitScale = Math.min(viewportWidth / naturalWidth, viewportHeight / naturalHeight, 1);

  return {
    width: Math.max(1, Math.round(naturalWidth * fitScale * zoom)),
    height: Math.max(1, Math.round(naturalHeight * fitScale * zoom)),
  };
}

function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(6, Math.max(0.25, Math.round(zoom * 100) / 100));
}

function scheduleFrame(callback: () => void) {
  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(() => callback());
  } else {
    setTimeout(callback, 0);
  }
}

@customElement("image-lightbox")
export class ImageLightbox extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @state() private isOpen = false;
  @state() private src = "";
  @state() private alt = "Image preview";
  @state() private imageTitle = "Image preview";
  @state() private zoom = 1;
  @state() private naturalWidth = 0;
  @state() private naturalHeight = 0;
  @state() private viewportWidth = 0;
  @state() private viewportHeight = 0;

  private resizeObserver: ResizeObserver | null = null;
  private observedViewport: HTMLElement | null = null;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.handleKeydown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.handleKeydown);
    this.disconnectResizeObserver();
  }

  show(detail: OpenImageViewerDetail) {
    this.src = detail.src;
    this.alt = detail.alt || "Image preview";
    this.imageTitle = detail.title || detail.alt || "Image preview";
    this.zoom = 1;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.viewportWidth = 0;
    this.viewportHeight = 0;
    this.isOpen = true;

    scheduleFrame(() => {
      this.measureViewport();
      if (typeof this.querySelector === "function") {
        this.querySelector<HTMLButtonElement>('[data-role="image-lightbox-close"]')?.focus();
      }
    });
  }

  close() {
    this.isOpen = false;
    this.src = "";
    this.disconnectResizeObserver();
  }

  private handleKeydown = (event: KeyboardEvent) => {
    if (!this.isOpen) return;

    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }

    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      this.zoomIn();
      return;
    }

    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      this.zoomOut();
      return;
    }

    if (event.key === "0") {
      event.preventDefault();
      this.resetZoom();
    }
  };

  private zoomIn = () => {
    this.zoom = clampZoom(this.zoom + 0.25);
  };

  private zoomOut = () => {
    this.zoom = clampZoom(this.zoom - 0.25);
  };

  private resetZoom = () => {
    this.zoom = 1;
  };

  private handleImageLoad = (event: Event) => {
    if (!(event.currentTarget instanceof HTMLImageElement)) return;
    this.naturalWidth = event.currentTarget.naturalWidth;
    this.naturalHeight = event.currentTarget.naturalHeight;
    this.measureViewport();
  };

  private handleWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (event.deltaY < 0) {
      this.zoomIn();
    } else {
      this.zoomOut();
    }
  };

  private handleBackdropClick = (event: MouseEvent) => {
    if (!(event.target instanceof HTMLElement)) return;
    const role = event.target.dataset.role;
    if (role === "image-lightbox-viewport" || role === "image-lightbox-stage") {
      this.close();
    }
  };

  private disconnectResizeObserver() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.observedViewport = null;
  }

  private observeViewport(viewport: HTMLElement) {
    if (this.observedViewport === viewport) return;
    this.disconnectResizeObserver();
    if (typeof ResizeObserver === "undefined") return;

    this.resizeObserver = new ResizeObserver(() => this.measureViewport());
    this.resizeObserver.observe(viewport);
    this.observedViewport = viewport;
  }

  private measureViewport() {
    if (!this.isOpen) return;
    if (typeof this.querySelector !== "function") return;
    const viewport = this.querySelector<HTMLElement>('[data-role="image-lightbox-viewport"]');
    if (!viewport) return;

    this.observeViewport(viewport);
    const nextWidth = viewport.clientWidth;
    const nextHeight = viewport.clientHeight;
    if (nextWidth !== this.viewportWidth) this.viewportWidth = nextWidth;
    if (nextHeight !== this.viewportHeight) this.viewportHeight = nextHeight;
  }

  override render() {
    if (!this.isOpen) return nothing;

    const hasDimensions = this.naturalWidth > 0 && this.naturalHeight > 0 && this.viewportWidth > 0 && this.viewportHeight > 0;
    const fitted = hasDimensions
      ? computeFittedImageSize({
        naturalWidth: this.naturalWidth,
        naturalHeight: this.naturalHeight,
        viewportWidth: this.viewportWidth,
        viewportHeight: this.viewportHeight,
        zoom: this.zoom,
      })
      : null;
    const imageStyle = fitted
      ? `width: ${fitted.width}px; height: ${fitted.height}px; max-width: none; max-height: none;`
      : "max-width: 100%; max-height: 100%;";
    const stageStyle = fitted
      ? `width: max(100%, ${fitted.width + 32}px); height: max(100%, ${fitted.height + 32}px);`
      : "";

    return html`
      <div
        class="fixed inset-0 z-[var(--layer-palette)] flex flex-col bg-zinc-950/95 text-zinc-100"
        role="dialog"
        aria-modal="true"
        aria-label="Image preview"
      >
        <div class="flex shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-950/95 px-3 py-2">
          <div class="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200" title=${this.imageTitle}>${this.imageTitle}</div>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="rounded-md px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white cursor-pointer"
              aria-label="Zoom out"
              title="Zoom out (-)"
              @click=${this.zoomOut}
            >−</button>
            <button
              type="button"
              class="min-w-24 rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-white cursor-pointer"
              aria-label="Reset zoom"
              title="Reset zoom (0)"
              @click=${this.resetZoom}
            >Zoom ${Math.round(this.zoom * 100)}%</button>
            <button
              type="button"
              class="rounded-md px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white cursor-pointer"
              aria-label="Zoom in"
              title="Zoom in (+)"
              @click=${this.zoomIn}
            >+</button>
            <button
              type="button"
              data-role="image-lightbox-close"
              class="ml-2 rounded-md px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white cursor-pointer"
              aria-label="Close image preview"
              title="Close image preview (Esc)"
              @click=${() => this.close()}
            >✕</button>
          </div>
        </div>
        <div
          data-role="image-lightbox-viewport"
          class="min-h-0 flex-1 overflow-auto"
          @click=${this.handleBackdropClick}
          @wheel=${this.handleWheel}
        >
          <div
            data-role="image-lightbox-stage"
            class="box-border flex min-h-full min-w-full items-center justify-center p-4"
            style=${stageStyle}
          >
            <img
              src=${this.src}
              alt=${this.alt}
              title=${this.imageTitle}
              class="rounded-lg bg-zinc-900 shadow-2xl"
              style=${imageStyle}
              draggable="false"
              @load=${this.handleImageLoad}
              @click=${(event: Event) => event.stopPropagation()}
            />
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "image-lightbox": ImageLightbox;
  }
}
