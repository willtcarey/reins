import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import {
  PartType,
  directive,
  type Part,
  type PartInfo,
} from "lit/directive.js";
import {
  DEFAULT_SPRING_DAMPING,
  DEFAULT_SPRING_STIFFNESS,
  Spring,
} from "../models/spring.js";

const LONG_PRESS_MS = 900;
const PRESS_FEEDBACK_DELAY_MS = 650;
const MOVE_TOLERANCE_PX = 10;
const PRESSED_SCALE = 0.97;

type FeedbackElement = HTMLElement;
type FeedbackTarget = string | ((element: Element) => FeedbackElement | null);
type Completion = void | Promise<void>;

export interface LongPressOptions {
  /** Element to animate, resolved beneath (or from) the registered element. */
  feedback?: FeedbackTarget;
  onComplete: () => Completion;
}

interface ActivePress {
  pointerId: number;
  startX: number;
  startY: number;
  completed: boolean;
  feedbackActive: boolean;
  feedback: FeedbackElement;
  transform: string;
  willChange: string;
  token: number;
}

function reducedMotionPreferred(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function canAnimate(): boolean {
  return !reducedMotionPreferred();
}

/** Adds a cancellable primary-touch long press to an element part. */
export class LongPressDirective extends AsyncDirective {
  private element: HTMLElement | null = null;
  private options: LongPressOptions | null = null;
  private press: ActivePress | null = null;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private spring: Spring | null = null;
  private springVelocity = 0;
  private token = 0;
  private listening = false;
  private connected = true;

  constructor(partInfo: PartInfo) {
    super(partInfo);
    if (partInfo.type !== PartType.ELEMENT) {
      throw new Error("longPress must be attached directly to an element");
    }
  }

  override render(_options: LongPressOptions) {
    return nothing;
  }

  override update(part: Part, [options]: [LongPressOptions]) {
    if (part.type !== PartType.ELEMENT) return nothing;
    const nextElement = part.element;
    if (!(nextElement instanceof HTMLElement)) {
      throw new Error("longPress must be attached to an HTML element");
    }
    if (this.element !== nextElement) {
      this.removeListeners();
      this.cancelPress(true);
      this.element = nextElement;
    }
    this.options = options;
    if (this.connected) this.addListeners();
    return nothing;
  }

  protected override disconnected() {
    this.connected = false;
    this.removeListeners();
    this.cancelPress(true);
  }

  protected override reconnected() {
    this.connected = true;
    this.addListeners();
  }

  private addListeners() {
    if (!this.element || this.listening) return;
    this.element.addEventListener("pointerdown", this.onPointerDown);
    this.element.addEventListener("pointermove", this.onPointerMove);
    this.element.addEventListener("pointerup", this.onPointerEnd);
    this.element.addEventListener("pointercancel", this.onPointerEnd);
    this.listening = true;
  }

  private removeListeners() {
    if (!this.element || !this.listening) return;
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.removeEventListener("pointermove", this.onPointerMove);
    this.element.removeEventListener("pointerup", this.onPointerEnd);
    this.element.removeEventListener("pointercancel", this.onPointerEnd);
    this.listening = false;
  }

  private readonly onPointerDown = (pointer: PointerEvent) => {
    if (
      pointer.pointerType !== "touch"
      || !pointer.isPrimary
      || !this.element
      || !this.options
    ) return;

    this.cancelPress(true);
    const feedback = this.resolveFeedback(this.options.feedback);
    if (!feedback) return;

    const token = ++this.token;
    this.press = {
      pointerId: pointer.pointerId,
      startX: pointer.clientX,
      startY: pointer.clientY,
      completed: false,
      feedbackActive: false,
      feedback,
      transform: feedback.style.transform,
      willChange: feedback.style.willChange,
      token,
    };
    this.feedbackTimer = setTimeout(() => {
      this.feedbackTimer = null;
      if (this.press?.token !== token) return;
      this.press.feedbackActive = true;
      feedback.style.willChange = feedback.style.willChange
        ? `${feedback.style.willChange}, transform`
        : "transform";
      this.animateTo(PRESSED_SCALE);
    }, PRESS_FEEDBACK_DELAY_MS);
    this.completionTimer = setTimeout(() => this.complete(token), LONG_PRESS_MS);
  };

  private readonly onPointerMove = (pointer: PointerEvent) => {
    const press = this.press;
    if (!press || press.completed || pointer.pointerId !== press.pointerId) return;
    if (
      Math.abs(pointer.clientX - press.startX) > MOVE_TOLERANCE_PX
      || Math.abs(pointer.clientY - press.startY) > MOVE_TOLERANCE_PX
    ) {
      this.cancelPress();
    }
  };

  private readonly onPointerEnd = (pointer: PointerEvent) => {
    if (!this.press || this.press.completed || pointer.pointerId !== this.press.pointerId) return;
    this.cancelPress();
  };

  private resolveFeedback(target: FeedbackTarget | undefined): FeedbackElement | null {
    if (!this.element) return null;
    if (typeof target === "function") return target(this.element);
    const candidate = typeof target === "string" ? this.element.querySelector(target) : this.element;
    return candidate instanceof HTMLElement ? candidate : null;
  }

  private complete(token: number) {
    if (!this.press || this.press.token !== token || !this.options) return;
    this.clearTimers();
    this.press.completed = true;
    const onComplete = this.options.onComplete;

    let completion: Completion;
    try {
      completion = onComplete();
    } catch (error) {
      this.release(token);
      throw error;
    }

    if (completion && typeof completion.then === "function") {
      void completion.then(
        () => this.release(token),
        () => this.release(token),
      );
    } else {
      this.release(token);
    }
  }

  private release(token: number) {
    if (this.press?.token !== token) return;
    this.animateTo(1);
  }

  private cancelPress(immediate = false) {
    this.clearTimers();
    if (!this.press) return;
    if (immediate || !this.press.feedbackActive) {
      this.restoreFeedback();
    } else {
      this.animateTo(1);
    }
  }

  private clearTimers() {
    if (this.completionTimer !== null) clearTimeout(this.completionTimer);
    if (this.feedbackTimer !== null) clearTimeout(this.feedbackTimer);
    this.completionTimer = null;
    this.feedbackTimer = null;
  }

  private animateTo(targetScale: number) {
    const press = this.press;
    if (!press) return;

    this.spring?.cancel();
    this.spring = null;
    const animationToken = ++this.token;

    if (!canAnimate()) {
      press.feedback.style.transform = targetScale === 1 ? press.transform : `scale(${targetScale})`;
      this.springVelocity = 0;
      if (targetScale === 1) this.restoreFeedback();
      return;
    }

    const currentScale = this.currentScale(press.feedback.style.transform);
    const scaleRange = 1 - PRESSED_SCALE;
    const progress = (1 - currentScale) / scaleRange * 100;
    const targetProgress = (1 - targetScale) / scaleRange * 100;
    this.spring = new Spring({
      value: progress,
      target: targetProgress,
      velocity: this.springVelocity,
      stiffness: DEFAULT_SPRING_STIFFNESS,
      damping: DEFAULT_SPRING_DAMPING,
      onUpdate: (value, velocity) => {
        if (animationToken !== this.token || this.press !== press) return;
        const scale = 1 - value / 100 * scaleRange;
        press.feedback.style.transform = `scale(${scale})`;
        this.springVelocity = velocity;
      },
      onSettle: () => {
        if (animationToken !== this.token || this.press !== press) return;
        this.spring = null;
        this.springVelocity = 0;
        if (targetScale === 1) this.restoreFeedback();
      },
    });
  }

  private currentScale(transform: string): number {
    const match = /^scale\(([-+]?\d*\.?\d+)\)$/.exec(transform);
    return match ? Number(match[1]) : 1;
  }

  private restoreFeedback() {
    const press = this.press;
    if (!press) return;
    this.token += 1;
    this.spring?.cancel();
    this.spring = null;
    press.feedback.style.transform = press.transform;
    press.feedback.style.willChange = press.willChange;
    this.springVelocity = 0;
    this.press = null;
  }
}

export const longPress = directive(LongPressDirective);
