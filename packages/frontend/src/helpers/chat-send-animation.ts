import {
  DEFAULT_SPRING_DAMPING,
  DEFAULT_SPRING_STIFFNESS,
  Spring,
} from "../models/spring.js";

export interface SendAnimationRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SendAnimationSource {
  rect: SendAnimationRect;
}

interface SendFlip {
  dx: number;
  dy: number;
  springDistance: number;
}

interface VisualViewportOffset {
  left: number;
  top: number;
}

export interface ChatSendAnimationHost {
  updateComplete: Promise<unknown>;
  querySelector(selectors: string): HTMLElement | null;
}

interface ActiveAnimation {
  token: number;
  messageKey: string;
  element: HTMLElement | null;
  flight: HTMLElement | null;
  reveal: () => void;
  revealed: boolean;
  resolve: (completed: boolean) => void;
  removeCancellationListeners: () => void;
  scrollContainer: HTMLElement | null;
  scrollStart: number;
}

const MIN_SPRING_DISTANCE = 100;
const SEND_SPRING_SPEED = 0.7;
const SEND_SPRING_STIFFNESS = DEFAULT_SPRING_STIFFNESS * SEND_SPRING_SPEED ** 2;
const SEND_SPRING_DAMPING = DEFAULT_SPRING_DAMPING * SEND_SPRING_SPEED;

function canAnimateOutgoingMessage(): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  return !(
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Owns the one local-submission animation for a chat panel. Starting another
 * animation supersedes the first; cancel always removes the fixed flight copy
 * and reveals the normal-flow destination.
 */
export class ChatSendAnimator {
  private active: ActiveAnimation | null = null;
  private spring: Spring | null = null;
  private nextToken = 1;

  constructor(private readonly host: ChatSendAnimationHost) {}

  canAnimateOutgoingMessage(): boolean {
    return canAnimateOutgoingMessage();
  }

  get scrollLocked(): boolean {
    return this.active !== null;
  }

  animate(
    messageKey: string,
    source: SendAnimationSource,
    reveal: () => void,
  ): Promise<boolean> {
    this.cancel();

    if (!canAnimateOutgoingMessage()) {
      reveal();
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      const scrollContainer = this.findScrollContainer();
      const active: ActiveAnimation = {
        token: this.nextToken++,
        messageKey,
        element: null,
        flight: null,
        reveal,
        revealed: false,
        resolve,
        removeCancellationListeners: () => {},
        scrollContainer,
        scrollStart: scrollContainer?.scrollTop ?? 0,
      };
      this.active = active;
      active.removeCancellationListeners = this.listenForCancellation();
      void this.start(active, source);
    });
  }

  cancel(): void {
    const active = this.active;
    if (!active) return;
    this.finish(active, false);
  }

  cancelIfTargetMissing(): void {
    const active = this.active;
    if (!active?.element) return;
    const current = this.findMessageRow(active.messageKey);
    if (current !== active.element) this.finish(active, false);
  }

  private async start(active: ActiveAnimation, source: SendAnimationSource): Promise<void> {
    try {
      await this.host.updateComplete;
      await nextAnimationFrame();
    } catch {
      this.finish(active, false);
      return;
    }

    if (this.active !== active || !canAnimateOutgoingMessage()) {
      this.finish(active, false);
      return;
    }

    const row = this.findMessageRow(active.messageKey);
    const destination = row?.querySelector<HTMLElement>('[data-role="user-message-animation-target"]');
    if (!row || !destination) {
      this.finish(active, false);
      return;
    }

    const currentDestinationRect = destination.getBoundingClientRect();
    if (currentDestinationRect.width <= 0 || currentDestinationRect.height <= 0) {
      this.finish(active, false);
      return;
    }

    const scrollDistance = this.scrollTarget(active) - active.scrollStart;
    const destinationRect: SendAnimationRect = {
      left: currentDestinationRect.left,
      top: currentDestinationRect.top - scrollDistance,
      width: currentDestinationRect.width,
      height: currentDestinationRect.height,
    };
    const clonedDestination = destination.cloneNode(true);
    if (!(clonedDestination instanceof HTMLElement)) {
      this.finish(active, false);
      return;
    }

    const dx = source.rect.left - destinationRect.left;
    const dy = source.rect.top - destinationRect.top;
    const flip: SendFlip = {
      dx,
      dy,
      springDistance: Math.max(Math.hypot(dx, dy), MIN_SPRING_DISTANCE),
    };
    active.element = row;
    active.flight = clonedDestination;
    // The real optimistic row keeps its normal-flow destination while a fixed
    // visual copy travels above the composer and scroll container. Because the
    // copy lives under body, it cannot alter Safari's scrollable overflow.
    this.configureFlight(clonedDestination, destinationRect);
    document.body.appendChild(clonedDestination);
    this.applyFrame(clonedDestination, flip, flip.springDistance);

    const spring = new Spring({
      value: flip.springDistance,
      target: 0,
      velocity: 0,
      stiffness: SEND_SPRING_STIFFNESS,
      damping: SEND_SPRING_DAMPING,
      onUpdate: (value) => {
        if (this.active !== active) return;
        this.applyFrame(clonedDestination, flip, value);
        this.applyScrollFrame(active, value / flip.springDistance);
      },
      onSettle: () => this.finish(active, true),
    });
    if (this.active === active) this.spring = spring;
    else spring.cancel();
  }

  private configureFlight(element: HTMLElement, destination: SendAnimationRect): void {
    element.classList.add("sent-message-flight");
    element.setAttribute("aria-hidden", "true");

    // DOM rects use visual-viewport coordinates on iOS while fixed positioning
    // uses the layout viewport. Account for the keyboard-shifted viewport here.
    const viewportOffset = currentVisualViewportOffset();
    element.style.position = "fixed";
    element.style.left = `${destination.left + viewportOffset.left}px`;
    element.style.top = `${destination.top + viewportOffset.top}px`;
    element.style.width = `${destination.width}px`;
    element.style.height = `${destination.height}px`;
    element.style.maxWidth = "none";
    element.style.margin = "0";
    element.style.pointerEvents = "none";
    element.style.zIndex = "2147483647";
    element.style.willChange = "transform";
  }

  private applyFrame(element: HTMLElement, flip: SendFlip, springValue: number): void {
    // Keep signed Spring overshoot so the message visibly settles around zero.
    const progress = springValue / flip.springDistance;
    element.style.transform = `translate3d(${flip.dx * progress}px, ${flip.dy * progress}px, 0)`;
  }

  private applyScrollFrame(active: ActiveAnimation, progress: number): void {
    const container = active.scrollContainer;
    if (!container) return;
    const target = this.scrollTarget(active);
    container.scrollTop = target + ((active.scrollStart - target) * progress);
  }

  private scrollTarget(active: ActiveAnimation): number {
    const container = active.scrollContainer;
    return container ? Math.max(0, container.scrollHeight - container.clientHeight) : 0;
  }

  private finish(active: ActiveAnimation, completed: boolean): void {
    if (this.active !== active) return;
    this.spring?.cancel();
    this.spring = null;
    active.removeCancellationListeners();
    if (active.scrollContainer) active.scrollContainer.scrollTop = this.scrollTarget(active);
    // Reveal synchronously so removing the flight copy cannot produce a blank
    // frame before Lit removes the temporary hidden class.
    active.element?.classList.remove("sent-message-target-hidden");
    this.reveal(active);
    active.flight?.remove();
    this.active = null;
    active.resolve(completed);
  }

  private reveal(active: ActiveAnimation): void {
    if (active.revealed) return;
    active.revealed = true;
    active.reveal();
  }

  private findMessageRow(messageKey: string): HTMLElement | null {
    if (typeof this.host.querySelector !== "function") return null;
    return this.host.querySelector(
      `[data-message-key="${cssEscape(messageKey)}"]`,
    );
  }

  private findScrollContainer(): HTMLElement | null {
    if (typeof this.host.querySelector !== "function") return null;
    return this.host.querySelector("#chat-scroll");
  }

  private listenForCancellation(): () => void {
    if (typeof window === "undefined") return () => {};
    const cancel = () => this.cancel();
    const events: Array<[EventTarget, string]> = [
      [window, "resize"],
      [window, "orientationchange"],
      [window, "hashchange"],
      [window, "popstate"],
      [window, "pagehide"],
    ];
    if (window.visualViewport) {
      events.push([window.visualViewport, "resize"], [window.visualViewport, "scroll"]);
    }
    for (const [target, type] of events) target.addEventListener(type, cancel);
    return () => {
      for (const [target, type] of events) target.removeEventListener(type, cancel);
    };
  }
}

function currentVisualViewportOffset(): VisualViewportOffset {
  if (typeof window === "undefined" || !window.visualViewport) return { left: 0, top: 0 };
  return {
    left: window.visualViewport.offsetLeft,
    top: window.visualViewport.offsetTop,
  };
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
