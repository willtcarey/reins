import { expect, mock, test } from "bun:test";
import { PartType, type PartInfo } from "lit/directive.js";
import { LongPressDirective } from "../../directives/long-press.js";

const elementPart: PartInfo = { type: PartType.ELEMENT };

class TestElement extends EventTarget {
  style = { transform: "", willChange: "" };

  querySelector() {
    return null;
  }
}

test("completed long press suppresses the primary control click", () => {
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

    expect(onComplete).toHaveBeenCalledTimes(1);
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
