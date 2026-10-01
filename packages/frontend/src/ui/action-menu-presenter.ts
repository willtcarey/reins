import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Spring } from "../models/spring.js";
import { computePosition, type AnchorRect } from "./position.js";

export type ActionMenuPresentation = "context" | "touch";

/** The long-pressed item and the touch point a touch menu grows out of. */
export interface TouchMenuAnchor {
  rect: AnchorRect;
  x: number;
  y: number;
}

export interface TouchMenuPlacementOptions {
  anchor: TouchMenuAnchor;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

const TOUCH_MENU_GAP = 8;
const TOUCH_MENU_MAX_ANCHOR_HEIGHT = 120;
const TOUCH_MENU_VIEWPORT_PAD = 8;
const TOUCH_MENU_HIDDEN_SCALE = 0.9;

/**
 * Places a touch menu beside a short pressed item (a row): below it, or above
 * when there is no room below. Taller items (most messages), or items that
 * leave no room either way, place the menu just above the touch point instead,
 * clear of the finger. The menu aligns to whichever edge of the
 * item is nearer the viewport's side, and its transform origin is the point
 * where it meets the item, so scaling makes it grow out of the item.
 */
export function touchMenuPlacement(options: TouchMenuPlacementOptions) {
  const { anchor, width, height, viewportWidth, viewportHeight } = options;
  const { rect } = anchor;
  const fitsBelow = rect.bottom + TOUCH_MENU_GAP + height <= viewportHeight - TOUCH_MENU_VIEWPORT_PAD;
  const fitsAbove = rect.top - TOUCH_MENU_GAP - height >= TOUCH_MENU_VIEWPORT_PAD;
  const atPoint = rect.height > TOUCH_MENU_MAX_ANCHOR_HEIGHT || (!fitsBelow && !fitsAbove);
  const source: AnchorRect = atPoint
    ? { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 }
    : rect;
  const alignEnd = source.left + source.width / 2 > viewportWidth / 2;

  const { top, left } = computePosition({
    anchor: source,
    width,
    height,
    placement: `${atPoint ? "top" : "bottom"}-${alignEnd ? "end" : "start"}`,
    gap: TOUCH_MENU_GAP,
    viewportPad: TOUCH_MENU_VIEWPORT_PAD,
    viewportWidth,
    viewportHeight,
  });
  const edge = alignEnd ? source.right : source.left;
  const below = top + height / 2 >= source.top + source.height / 2;
  return {
    left,
    top,
    originX: Math.max(0, Math.min(edge - left, width)),
    originY: below ? 0 : height,
  };
}

function reducedMotionPreferred(): boolean {
  return typeof window === "undefined"
    || typeof window.matchMedia !== "function"
    || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Presentation =
  | { kind: "touch"; anchor: TouchMenuAnchor }
  | { kind: "context"; x: number; y: number };

/** Presents caller-owned actions in a cursor menu or a touch menu anchored to a long-pressed item. */
@customElement("action-menu-presenter")
export class ActionMenuPresenter extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) ariaLabel = "Actions";
  @property({ type: Number }) contextWidth = 160;
  @property({ type: Number }) contextHeight = 48;
  @property({ type: Boolean }) dismissOnContextMenu = false;
  @property({ attribute: false }) content: ((presentation: ActionMenuPresentation) => TemplateResult) | null = null;

  @state() private presentation: Presentation | null = null;
  @state() private closing = false;

  private resolveDismissal: (() => void) | null = null;
  private placed = false;
  private spring: Spring | null = null;
  private progress = 0;
  private velocity = 0;

  get isOpen(): boolean {
    return this.presentation !== null && !this.closing;
  }

  openContext(x: number, y: number): void {
    this.close();
    this.removeMenu();
    this.presentation = { kind: "context", x, y };
  }

  openTouch(anchor: TouchMenuAnchor): Promise<void> {
    this.close();
    this.removeMenu();
    this.presentation = { kind: "touch", anchor };
    return new Promise((resolve) => {
      this.resolveDismissal = resolve;
    });
  }

  /** Dismisses the menu at once; a touch menu then shrinks back into its item before it is removed. */
  close(): void {
    if (!this.presentation || this.closing) return;
    this.resolveDismissal?.();
    this.resolveDismissal = null;
    this.dispatchEvent(new Event("action-menu-dismiss"));

    if (this.presentation.kind === "touch" && this.placed) {
      this.closing = true;
      this.animateTo(0, () => this.removeMenu());
    } else {
      this.removeMenu();
    }
  }

  override disconnectedCallback() {
    this.close();
    this.removeMenu();
    super.disconnectedCallback();
  }

  override updated() {
    const overlay = this.querySelector<HTMLElement>("[data-role=action-menu-presenter]");
    if (!overlay) return;

    if (!overlay.matches(":popover-open")) {
      overlay.showPopover();
      overlay.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    }

    const presentation = this.presentation;
    if (presentation?.kind !== "touch" || this.placed) return;
    const panel = this.touchPanel;
    if (!panel) return;
    this.placed = true;
    const placement = touchMenuPlacement({
      anchor: presentation.anchor,
      width: panel.offsetWidth,
      height: panel.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    panel.style.left = `${placement.left}px`;
    panel.style.top = `${placement.top}px`;
    panel.style.transformOrigin = `${placement.originX}px ${placement.originY}px`;
    this.animateTo(1);
  }

  override render() {
    const presentation = this.presentation;
    if (!presentation || !this.content) return nothing;

    return html`
      <div
        data-role="action-menu-presenter"
        popover="manual"
        class="fixed inset-0 m-0 h-[100dvh] max-h-none w-screen max-w-none border-0 bg-transparent p-0 z-[var(--layer-overlay)] ${this.closing ? "pointer-events-none" : ""}"
        role="menu"
        aria-label=${this.ariaLabel}
        @click=${this.close}
        @contextmenu=${this.handleBackdropContextMenu}
        @keydown=${this.handleKeyDown}
      >
        ${presentation.kind === "touch" ? html`
          <div data-role="action-menu-touch-backdrop" class="absolute inset-0 bg-black/30" style="opacity: 0"></div>
          <div
            data-role="action-menu-touch-panel"
            class="absolute w-60 max-w-[calc(100vw-1rem)] divide-y divide-zinc-700/70 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-800 shadow-2xl"
            style="opacity: 0"
            @click=${(event: Event) => event.stopPropagation()}
          >
            ${this.content("touch")}
          </div>
        ` : html`
          <div
            class="absolute overflow-hidden rounded-md border border-zinc-600 bg-zinc-800 shadow-xl"
            style=${this.contextStyle(presentation.x, presentation.y)}
            @click=${(event: Event) => event.stopPropagation()}
          >
            ${this.content("context")}
          </div>
        `}
      </div>
    `;
  }

  private get touchPanel(): HTMLElement | null {
    return this.querySelector<HTMLElement>("[data-role=action-menu-touch-panel]");
  }

  private removeMenu() {
    this.spring?.cancel();
    this.spring = null;
    this.progress = 0;
    this.velocity = 0;
    this.placed = false;
    this.closing = false;
    this.presentation = null;
  }

  private animateTo(target: 0 | 1, onSettle?: () => void) {
    this.spring?.cancel();
    this.spring = null;

    if (reducedMotionPreferred()) {
      this.progress = target;
      this.velocity = 0;
      this.applyProgress();
      onSettle?.();
      return;
    }

    this.spring = new Spring({
      value: this.progress * 100,
      target: target * 100,
      velocity: this.velocity * 100,
      onUpdate: (value, velocity) => {
        this.progress = value / 100;
        this.velocity = velocity / 100;
        this.applyProgress();
      },
      onSettle: () => {
        this.spring = null;
        this.velocity = 0;
        onSettle?.();
      },
    });
  }

  private applyProgress() {
    const panel = this.touchPanel;
    const backdrop = this.querySelector<HTMLElement>("[data-role=action-menu-touch-backdrop]");
    if (!panel || !backdrop) return;
    const visible = `${Math.max(0, Math.min(this.progress, 1))}`;
    panel.style.opacity = visible;
    panel.style.transform = `scale(${TOUCH_MENU_HIDDEN_SCALE + (1 - TOUCH_MENU_HIDDEN_SCALE) * this.progress})`;
    backdrop.style.opacity = visible;
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") this.close();
  }

  private handleBackdropContextMenu(event: MouseEvent) {
    if (!this.dismissOnContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
  }

  private contextStyle(x: number, y: number): string {
    const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
    const left = Math.max(8, Math.min(x, viewportWidth - this.contextWidth - 8));
    const top = Math.max(8, Math.min(y, viewportHeight - this.contextHeight));
    return `left: ${left}px; top: ${top}px; width: ${this.contextWidth}px`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "action-menu-presenter": ActionMenuPresenter;
  }
}
