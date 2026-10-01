import { expect, mock, test } from "bun:test";
import { PartType, type PartInfo } from "lit/directive.js";
import { LongPressDirective } from "../../directives/long-press.js";

const elementPart: PartInfo = { type: PartType.ELEMENT };

class TestElement extends EventTarget {
  style = { transform: "", willChange: "" };

  querySelector() {
    return null;
  }

  getBoundingClientRect() {
    return { left: 4, top: 8, width: 120, height: 40, right: 124, bottom: 48 };
  }
}

test("press feedback starts with completion, in step with the menu it opens", () => {
  const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalSetTimeout = globalThis.setTimeout;
  const timers: Array<() => void> = [];
  Reflect.set(globalThis, "HTMLElement", TestElement);
  Reflect.set(globalThis, "window", { matchMedia: () => ({ matches: true }) });
  Reflect.set(globalThis, "setTimeout", (callback: () => void) => {
    timers.push(callback);
    return timers.length;
  });

  try {
    const element = new TestElement();
    const transformsAtCompletion: string[] = [];
    const onComplete = mock(() => {
      transformsAtCompletion.push(element.style.transform);
    });
    const directive = new LongPressDirective(elementPart);
    Reflect.apply(directive.update, directive, [
      { type: PartType.ELEMENT, element },
      [{ onComplete }],
    ]);

    const pointer = new Event("pointerdown");
    Object.defineProperties(pointer, {
      pointerType: { value: "touch" },
      isPrimary: { value: true },
      pointerId: { value: 1 },
      clientX: { value: 10 },
      clientY: { value: 10 },
    });
    element.dispatchEvent(pointer);

    for (const timer of timers.splice(0)) {
      if (onComplete.mock.calls.length === 0) expect(element.style.transform).toBe("");
      timer();
    }

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(transformsAtCompletion).toEqual(["scale(0.97)"]);
  } finally {
    Reflect.set(globalThis, "setTimeout", originalSetTimeout);
    if (originalHTMLElement) Object.defineProperty(globalThis, "HTMLElement", originalHTMLElement);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("completed long press reports the pressed item and point, then suppresses the primary control click", () => {
  const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalSetTimeout = globalThis.setTimeout;
  Reflect.set(globalThis, "HTMLElement", TestElement);
  Reflect.set(globalThis, "window", { matchMedia: () => ({ matches: true }) });
  Reflect.set(globalThis, "setTimeout", (callback: () => void) => {
    callback();
    return 1;
  });

  try {
    const element = new TestElement();
    const onComplete = mock(() => undefined);
    const onClick = mock(() => undefined);
    element.addEventListener("click", onClick);

    const directive = new LongPressDirective(elementPart);
    Reflect.apply(directive.update, directive, [
      { type: PartType.ELEMENT, element },
      [{ onComplete }],
    ]);

    const pointer = new Event("pointerdown");
    Object.defineProperties(pointer, {
      pointerType: { value: "touch" },
      isPrimary: { value: true },
      pointerId: { value: 1 },
      clientX: { value: 10 },
      clientY: { value: 10 },
    });
    element.dispatchEvent(pointer);

    const click = new Event("click", { cancelable: true });
    element.dispatchEvent(click);

    expect(onComplete).toHaveBeenCalledWith({
      rect: { left: 4, top: 8, width: 120, height: 40, right: 124, bottom: 48 },
      x: 10,
      y: 10,
    });
    expect(click.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  } finally {
    Reflect.set(globalThis, "setTimeout", originalSetTimeout);
    if (originalHTMLElement) Object.defineProperty(globalThis, "HTMLElement", originalHTMLElement);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("touches inside the open menu keep the item pressed until the menu dismisses", async () => {
  const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalSetTimeout = globalThis.setTimeout;
  Reflect.set(globalThis, "HTMLElement", TestElement);
  Reflect.set(globalThis, "window", { matchMedia: () => ({ matches: true }) });
  const timers: Array<() => void> = [];
  Reflect.set(globalThis, "setTimeout", (callback: () => void) => {
    timers.push(callback);
    return timers.length;
  });

  try {
    const element = new TestElement();
    const { promise: dismissed, resolve: dismiss } = Promise.withResolvers<void>();
    const directive = new LongPressDirective(elementPart);
    Reflect.apply(directive.update, directive, [
      { type: PartType.ELEMENT, element },
      [{ onComplete: () => dismissed }],
    ]);

    element.dispatchEvent(touchPointerDown(1));
    for (const timer of timers.splice(0)) timer();
    expect(element.style.transform).toBe("scale(0.97)");

    // The menu is rendered inside the pressed element, so its touches bubble here.
    element.dispatchEvent(touchPointerDown(2));
    expect(element.style.transform).toBe("scale(0.97)");

    dismiss();
    await dismissed;
    expect(element.style.transform).toBe("");
  } finally {
    Reflect.set(globalThis, "setTimeout", originalSetTimeout);
    if (originalHTMLElement) Object.defineProperty(globalThis, "HTMLElement", originalHTMLElement);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

function touchPointerDown(pointerId: number): Event {
  const pointer = new Event("pointerdown");
  Object.defineProperties(pointer, {
    pointerType: { value: "touch" },
    isPrimary: { value: true },
    pointerId: { value: pointerId },
    clientX: { value: 10 },
    clientY: { value: 10 },
  });
  return pointer;
}
