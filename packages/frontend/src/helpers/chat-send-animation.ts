export interface SendAnimationRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SendAnimationOrigin {
  rect: SendAnimationRect;
  backgroundColor: string;
  borderRadius: string;
}

export interface ConversationShiftSnapshotItem {
  key: string;
  left: number;
  top: number;
}

export interface ConversationShiftDelta {
  key: string;
  dx: number;
  dy: number;
}

export interface SendAnimationGeometry {
  startLeft: number;
  startTop: number;
  startWidth: number;
  startHeight: number;
  targetLeft: number;
  targetTop: number;
  dx: number;
  dy: number;
}

export interface SendAnimationStages {
  finalDx: number;
  finalDy: number;
  scale: number;
  durationMs: number;
}

export interface ChatSendAnimationHost {
  updateComplete: Promise<unknown>;
  querySelector<E extends Element = Element>(selectors: string): E | null;
  querySelectorAll<E extends Element = Element>(selectors: string): NodeListOf<E>;
}

export function computeConversationShiftDeltas(
  before: ConversationShiftSnapshotItem[],
  after: ConversationShiftSnapshotItem[],
): ConversationShiftDelta[] {
  const afterByKey = new Map(after.map((item) => [item.key, item]));
  const deltas: ConversationShiftDelta[] = [];

  for (const item of before) {
    const next = afterByKey.get(item.key);
    if (!next) continue;

    const dx = item.left - next.left;
    const dy = item.top - next.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;

    deltas.push({ key: item.key, dx, dy });
  }

  return deltas;
}

export function computeSendAnimationStages(delta: { dx: number; dy: number }): SendAnimationStages {
  return {
    finalDx: delta.dx,
    finalDy: delta.dy,
    scale: 1,
    durationMs: 220,
  };
}

export function computeSendAnimationGeometry(
  originRect: SendAnimationRect,
  targetRect: SendAnimationRect,
  layerRect: SendAnimationRect,
): SendAnimationGeometry {
  const startWidth = Math.min(originRect.width, targetRect.width);
  const startHeight = Math.min(originRect.height, targetRect.height);
  const startLeft = originRect.left - layerRect.left;
  const startTop = originRect.top + ((originRect.height - startHeight) / 2) - layerRect.top;
  const targetLeft = targetRect.left - layerRect.left;
  const targetTop = targetRect.top - layerRect.top;

  return {
    startLeft,
    startTop,
    startWidth,
    startHeight,
    targetLeft,
    targetTop,
    dx: targetLeft - startLeft,
    dy: targetTop - startTop,
  };
}

export function canAnimateOutgoingMessage(): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  if (
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return false;
  }
  return true;
}

export function captureConversationShiftSnapshot(
  host: ChatSendAnimationHost,
  onlyVisible = true,
): ConversationShiftSnapshotItem[] {
  if (typeof host.querySelector !== "function" || typeof host.querySelectorAll !== "function") return [];

  const container = host.querySelector<HTMLElement>("#chat-scroll");
  if (!container) return [];

  const containerRect = container.getBoundingClientRect();
  const items: ConversationShiftSnapshotItem[] = [];
  const elements = host.querySelectorAll<HTMLElement>("[data-conversation-key]");

  for (const element of elements) {
    const key = element.dataset.conversationKey;
    if (!key) continue;

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (onlyVisible && (rect.bottom < containerRect.top || rect.top > containerRect.bottom)) continue;

    items.push({ key, left: rect.left, top: rect.top });
  }

  return items;
}

export async function runConversationShiftAnimation(
  host: ChatSendAnimationHost,
  before: ConversationShiftSnapshotItem[],
): Promise<void> {
  if (before.length === 0) return;

  const animated: Array<{
    element: HTMLElement;
    transition: string;
    transform: string;
    willChange: string;
  }> = [];

  try {
    await host.updateComplete;
    await waitForAnimationFrame();

    if (!canAnimateOutgoingMessage()) return;

    const after = captureConversationShiftSnapshot(host, false);
    const deltas = computeConversationShiftDeltas(before, after);
    if (deltas.length === 0) return;

    const elementsByKey = new Map<string, HTMLElement>();
    for (const element of host.querySelectorAll<HTMLElement>("[data-conversation-key]")) {
      const key = element.dataset.conversationKey;
      if (key) elementsByKey.set(key, element);
    }

    for (const delta of deltas) {
      const element = elementsByKey.get(delta.key);
      if (!element) continue;

      const transform = element.style.transform;
      const baseTransform = transform && transform !== "none" ? transform : "";
      animated.push({
        element,
        transition: element.style.transition,
        transform,
        willChange: element.style.willChange,
      });

      element.classList.add("conversation-shift-animating");
      element.style.transition = "none";
      element.style.transform = `translate3d(${delta.dx}px, ${delta.dy}px, 0)${baseTransform ? ` ${baseTransform}` : ""}`;
      element.style.willChange = "transform";
    }

    if (animated.length === 0) return;

    await waitForAnimationFrame();

    const durationMs = 220;
    const easing = "cubic-bezier(0.16, 1, 0.3, 1)";
    for (const item of animated) {
      item.element.style.transition = `transform ${durationMs}ms ${easing}`;
      item.element.style.transform = item.transform;
    }

    await Promise.all(animated.map((item) => waitForTransition(item.element, durationMs)));
  } finally {
    for (const item of animated) {
      item.element.classList.remove("conversation-shift-animating");
      item.element.style.transition = item.transition;
      item.element.style.transform = item.transform;
      item.element.style.willChange = item.willChange;
    }
  }
}

export async function runOutgoingMessageAnimation(
  host: ChatSendAnimationHost,
  messageKey: string,
  origin: SendAnimationOrigin,
  revealOutgoingMessage: () => void,
): Promise<void> {
  let ghost: HTMLElement | null = null;

  try {
    await host.updateComplete;
    await waitForAnimationFrame();

    if (!canAnimateOutgoingMessage()) return;

    const target = host.querySelector<HTMLElement>(
      `[data-message-key="${cssEscape(messageKey)}"] [data-role="user-message-bubble"]`,
    );
    if (!target) return;

    const targetRect = target.getBoundingClientRect();
    if (targetRect.width <= 0 || targetRect.height <= 0) return;

    const layer = host.querySelector<HTMLElement>('[data-role="send-animation-layer"]');
    if (!layer) return;
    const layerRect = layer.getBoundingClientRect();
    const geometry = computeSendAnimationGeometry(origin.rect, targetRect, layerRect);

    const targetStyle = typeof globalThis.getComputedStyle === "function"
      ? globalThis.getComputedStyle(target)
      : null;
    const targetBackground = targetStyle?.backgroundColor || "rgb(37, 99, 235)";
    const targetBorderRadius = targetStyle?.borderRadius || "16px";

    const clonedTarget = target.cloneNode(true);
    if (!(clonedTarget instanceof HTMLElement)) return;
    ghost = clonedTarget;
    ghost.classList.add("sent-message-ghost");
    ghost.style.position = "absolute";
    ghost.style.left = `${geometry.startLeft}px`;
    ghost.style.top = `${geometry.startTop}px`;
    ghost.style.width = `${geometry.startWidth}px`;
    ghost.style.height = `${geometry.startHeight}px`;
    ghost.style.maxWidth = "none";
    ghost.style.overflow = "hidden";
    ghost.style.boxSizing = "border-box";
    ghost.style.margin = "0";
    ghost.style.pointerEvents = "none";
    ghost.style.zIndex = "var(--layer-overlay)";
    ghost.style.transformOrigin = "top left";
    ghost.style.transform = "translate3d(0, 0, 0) scale(0.995)";
    ghost.style.backgroundColor = origin.backgroundColor;
    ghost.style.borderRadius = origin.borderRadius;
    ghost.style.opacity = "0.96";
    ghost.style.boxShadow = "0 0 0 rgba(0, 0, 0, 0)";
    ghost.style.willChange = "transform, width, height, opacity";
    ghost.style.contain = "layout paint";
    layer.appendChild(ghost);

    await waitForAnimationFrame();
    ghost.getBoundingClientRect();

    const stages = computeSendAnimationStages(geometry);
    const travelEasing = "cubic-bezier(0.16, 1, 0.3, 1)";

    ghost.style.transition = [
      `transform ${stages.durationMs}ms ${travelEasing}`,
      `width ${stages.durationMs}ms ${travelEasing}`,
      `height ${stages.durationMs}ms ${travelEasing}`,
      `background-color ${stages.durationMs}ms ease-out`,
      `border-radius ${stages.durationMs}ms ${travelEasing}`,
      `opacity ${stages.durationMs}ms ease-out`,
    ].join(", ");
    ghost.style.transform = `translate3d(${stages.finalDx}px, ${stages.finalDy}px, 0) scale(${stages.scale})`;
    ghost.style.width = `${targetRect.width}px`;
    ghost.style.height = `${targetRect.height}px`;
    ghost.style.backgroundColor = targetBackground;
    ghost.style.borderRadius = targetBorderRadius;
    ghost.style.opacity = "1";

    await waitForTransition(ghost, stages.durationMs);
  } finally {
    revealOutgoingMessage();
    await host.updateComplete.catch(() => undefined);
    ghost?.remove();
  }
}

export class ChatSendAnimator {
  constructor(private host: ChatSendAnimationHost) {}

  canAnimateOutgoingMessage(): boolean {
    return canAnimateOutgoingMessage();
  }

  captureConversationShiftSnapshot(onlyVisible = true): ConversationShiftSnapshotItem[] {
    return captureConversationShiftSnapshot(this.host, onlyVisible);
  }

  runConversationShiftAnimation(before: ConversationShiftSnapshotItem[]): Promise<void> {
    return runConversationShiftAnimation(this.host, before);
  }

  runOutgoingMessageAnimation(
    messageKey: string,
    origin: SendAnimationOrigin,
    revealOutgoingMessage: () => void,
  ): Promise<void> {
    return runOutgoingMessageAnimation(this.host, messageKey, origin, revealOutgoingMessage);
  }
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function waitForTransition(element: HTMLElement, durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      element.removeEventListener("transitionend", onTransitionEnd);
      resolve();
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === "transform") finish();
    };
    const timeout = setTimeout(finish, durationMs + 120);
    element.addEventListener("transitionend", onTransitionEnd);
  });
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
