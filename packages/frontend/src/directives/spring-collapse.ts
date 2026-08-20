import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import {
  PartType,
  directive,
  type PartInfo,
} from "lit/directive.js";
import { ref } from "lit/directives/ref.js";
import { Spring } from "../models/spring.js";

const BASE_STIFFNESS = 0.00065;
const BASE_DAMPING = 0.05;
const REFERENCE_HEIGHT_PX = 240;
const MAX_STRENGTH_SCALE = 1.6;

export interface SpringCollapseOptions {
  /** Called after collapsed content has been removed from the DOM. */
  onUnmount?: () => void;
  /** Called after either collapse direction reaches its settled DOM state. */
  onSettled?: () => void;
  /** Animate ambient body resizes after expansion has settled. */
  animateContentResize?: boolean;
}

type RenderBody = () => unknown;

function springTuning(height: number): { stiffness: number; damping: number } {
  const scale = Math.min(
    MAX_STRENGTH_SCALE,
    Math.max(1, Math.log2(1 + height / REFERENCE_HEIGHT_PX)),
  );
  return {
    stiffness: BASE_STIFFNESS * scale,
    damping: BASE_DAMPING * Math.sqrt(scale),
  };
}

/** Lazily renders content and owns its spring collapse/expand lifecycle. */
export class SpringCollapseDirective extends AsyncDirective {
  private initialized = false;
  private collapsed = true;
  private mounted = false;
  private pending = false;
  private element: HTMLElement | null = null;
  private content: HTMLElement | null = null;
  private naturalHeight: number | null = null;
  private renderBody: RenderBody = () => nothing;
  private options: SpringCollapseOptions = {};
  private resizeObserver: ResizeObserver | null = null;
  private spring: Spring | null = null;
  private velocity = 0;
  private generation = 0;

  constructor(partInfo: PartInfo) {
    super(partInfo);
    if (partInfo.type !== PartType.CHILD) {
      throw new Error("springCollapse must be used in a child expression");
    }
  }

  override render(
    collapsed: boolean,
    renderBody: RenderBody,
    options: SpringCollapseOptions = {},
  ) {
    this.renderBody = renderBody;
    this.options = options;

    if (!this.initialized) {
      this.initialized = true;
      this.collapsed = collapsed;
      this.mounted = !collapsed;
      return this.renderContent();
    }

    if (collapsed !== this.collapsed) {
      this.collapsed = collapsed;
      this.cancelSpring();

      if (!this.canAnimate()) {
        this.pending = false;
        this.velocity = 0;
        this.mounted = !collapsed;
        if (collapsed) this.options.onUnmount?.();
        this.options.onSettled?.();
      } else {
        this.mounted = true;
        this.pending = true;
        this.scheduleAnimation();
      }
    }

    return this.renderContent();
  }

  protected override disconnected() {
    this.cancelSpring();
    this.disconnectResizeObserver();
  }

  protected override reconnected() {
    this.observeContent();
    if (this.pending) this.scheduleAnimation();
  }

  private renderContent() {
    if (!this.mounted) return nothing;
    return html`
      <div
        data-spring-collapse
        ${ref(this.captureElement)}
        aria-hidden=${String(this.collapsed)}
        ?inert=${this.collapsed}
      >
        <div
          data-spring-collapse-content
          style="display: flow-root"
          ${ref(this.captureContent)}
        >
          ${this.renderBody()}
        </div>
      </div>
    `;
  }

  private readonly captureElement = (element: Element | undefined) => {
    this.element = element instanceof HTMLElement ? element : null;
    if (this.pending) this.scheduleAnimation();
  };

  private readonly captureContent = (element: Element | undefined) => {
    const content = element instanceof HTMLElement ? element : null;
    if (content === this.content) return;
    this.disconnectResizeObserver();
    this.content = content;
    this.naturalHeight = content ? this.measureContent(content) : null;
    this.observeContent();
    if (this.pending) this.scheduleAnimation();
  };

  private observeContent() {
    if (!this.content || typeof ResizeObserver === "undefined" || this.resizeObserver) return;
    this.resizeObserver = new ResizeObserver(() => this.contentHeightChanged());
    this.resizeObserver.observe(this.content);
  }

  private disconnectResizeObserver() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private contentHeightChanged() {
    const element = this.element;
    const content = this.content;
    if (!element || !content || this.collapsed || !this.mounted) return;

    const previousHeight = this.naturalHeight;
    const nextHeight = this.measureContent(content);
    this.naturalHeight = nextHeight;
    if (previousHeight === null || nextHeight === previousHeight) return;
    if (this.pending) {
      this.scheduleAnimation();
      return;
    }
    if (this.options.animateContentResize === false || !this.canAnimate()) return;

    const renderedHeight = Number.parseFloat(element.style.height);
    const start = Number.isFinite(renderedHeight) ? renderedHeight : previousHeight;
    this.cancelSpring();
    this.animateHeight(element, start, nextHeight, nextHeight);
  }

  private scheduleAnimation() {
    const generation = this.generation;
    queueMicrotask(() => {
      if (
        generation !== this.generation
        || !this.pending
        || !this.element
        || !this.content
      ) return;
      this.startAnimation(this.element, this.content);
    });
  }

  private startAnimation(element: HTMLElement, content: HTMLElement) {
    this.pending = false;
    const naturalHeight = this.measureContent(content);
    this.naturalHeight = naturalHeight;
    const renderedHeight = Number.parseFloat(element.style.height);
    const start = this.collapsed
      ? (Number.isFinite(renderedHeight) ? renderedHeight : naturalHeight)
      : (Number.isFinite(renderedHeight) ? renderedHeight : 0);
    const target = this.collapsed ? 0 : naturalHeight;

    element.style.overflow = "hidden";
    element.style.height = `${Math.max(0, start)}px`;

    // Keep an expansion from empty content at zero. ResizeObserver will supply
    // the target once asynchronous content arrives.
    if (!this.collapsed && naturalHeight === 0) {
      this.velocity = 0;
      return;
    }
    if (start === target) {
      this.settle(element);
      return;
    }

    this.animateHeight(element, start, target, naturalHeight);
  }

  private animateHeight(
    element: HTMLElement,
    start: number,
    target: number,
    naturalHeight: number,
  ) {
    element.style.overflow = "hidden";
    element.style.height = `${Math.max(0, start)}px`;

    const generation = ++this.generation;
    const tuning = springTuning(Math.max(naturalHeight, start));
    let settledSynchronously = false;
    const spring = new Spring({
      value: start,
      target,
      velocity: this.velocity,
      stiffness: tuning.stiffness,
      damping: tuning.damping,
      onUpdate: (value, velocity) => {
        if (generation !== this.generation || this.element !== element) return;
        const upperBound = Math.max(naturalHeight, start);
        element.style.height = `${Math.max(0, Math.min(value, upperBound))}px`;
        this.velocity = velocity;
      },
      onSettle: () => {
        if (generation !== this.generation || this.element !== element) return;
        settledSynchronously = true;
        this.spring = null;
        this.settle(element);
      },
    });
    if (!settledSynchronously && generation === this.generation) this.spring = spring;
  }

  private settle(element: HTMLElement) {
    this.velocity = 0;
    if (this.collapsed) {
      this.mounted = false;
      this.disconnectResizeObserver();
      this.setValue(nothing);
      this.options.onUnmount?.();
      this.options.onSettled?.();
      return;
    }
    element.style.removeProperty("height");
    element.style.removeProperty("overflow");
    this.options.onSettled?.();
  }

  private measureContent(content: HTMLElement): number {
    return Math.max(0, Number.isFinite(content.scrollHeight) ? content.scrollHeight : 0);
  }

  private cancelSpring() {
    this.generation += 1;
    this.spring?.cancel();
    this.spring = null;
  }

  private canAnimate(): boolean {
    return typeof ResizeObserver !== "undefined"
      && !(
        typeof window !== "undefined"
        && typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      );
  }
}

export const springCollapse = directive(SpringCollapseDirective);
