import type { ReactiveController, ReactiveControllerHost } from "lit";
import { Spring } from "../models/spring.js";

interface MeasurableDiffBody {
  readonly scrollHeight: number;
}

// Avoid visible overshoot when animating the height of a large diff body.
const REVIEW_DIFF_SPRING_DAMPING = 0.05;

/**
 * Presentational mount/height state for an animated review diff body.
 * The review item remains the source of truth for the desired collapsed state.
 */
export class ReviewDiffBodyAnimation implements ReactiveController {
  renderBody = true;
  height: number | null = null;

  private initialized = false;
  private collapsed = false;
  private pending = false;
  private velocity = 0;
  private spring: Spring | null = null;
  private generation = 0;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  shouldRender(collapsed: boolean): boolean {
    return this.initialized ? this.renderBody : !collapsed;
  }

  /** Synchronize the persistent desired state before the host renders. */
  sync(collapsed: boolean) {
    if (!this.initialized) {
      this.initialized = true;
      this.collapsed = collapsed;
      this.renderBody = !collapsed;
      return;
    }
    if (collapsed === this.collapsed) return;

    this.collapsed = collapsed;
    this.cancelSpring();

    if (this.prefersReducedMotion()) {
      this.renderBody = !collapsed;
      this.height = null;
      this.velocity = 0;
      this.pending = false;
      return;
    }

    this.renderBody = true;
    if (!collapsed && this.height === null) this.height = 0;
    this.pending = true;
  }

  /** Start or reverse the animation after Pierre has rendered the mounted body. */
  bodyReady(body: MeasurableDiffBody | null) {
    if (!this.pending || !body) return;

    const naturalHeight = Math.max(0, Number.isFinite(body.scrollHeight) ? body.scrollHeight : 0);
    const start = Math.max(0, Math.min(this.height ?? naturalHeight, naturalHeight));
    const target = this.collapsed ? 0 : naturalHeight;
    this.height = start;
    this.pending = false;

    if (naturalHeight === 0 || start === target) {
      this.settle();
      this.host.requestUpdate();
      return;
    }

    const generation = ++this.generation;
    let settledSynchronously = false;
    const spring = new Spring({
      value: start,
      target,
      velocity: this.velocity,
      damping: REVIEW_DIFF_SPRING_DAMPING,
      onUpdate: (value, velocity) => {
        if (generation !== this.generation) return;
        this.height = Math.max(0, Math.min(value, naturalHeight));
        this.velocity = velocity;
        this.host.requestUpdate();
      },
      onSettle: () => {
        if (generation !== this.generation) return;
        settledSynchronously = true;
        this.spring = null;
        this.settle();
        this.host.requestUpdate();
      },
    });
    if (!settledSynchronously && generation === this.generation) this.spring = spring;
  }

  hostDisconnected() {
    this.cancelSpring();
  }

  private settle() {
    this.velocity = 0;
    this.height = null;
    this.renderBody = !this.collapsed;
  }

  private cancelSpring() {
    this.generation += 1;
    this.spring?.cancel();
    this.spring = null;
  }

  private prefersReducedMotion(): boolean {
    return typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
}
