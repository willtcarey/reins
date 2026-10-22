import { LitElement } from "lit";

class TestElement extends LitElement {}

const parents = new WeakMap<object, { children: unknown[] }>();

/**
 * Gives an element the parts of the DOM that mounting a view uses and Lit's DOM shim lacks: its
 * children (`childNodes`, `append`, `replaceChildren`, `remove`), whether it is on the page
 * (`isConnected`, set by `setConnected`), and an `ownerDocument` whose `createElement` makes such
 * elements too (a defined custom element as its own class).
 */
export function testDom<E extends HTMLElement>(element: E): E {
  const node = { children: Array<unknown>() };
  const detach = (child: unknown) => {
    const parent = typeof child === "object" && child !== null ? parents.get(child) : undefined;
    if (!parent || typeof child !== "object" || child === null) return;
    parent.children = parent.children.filter((entry) => entry !== child);
    parents.delete(child);
  };
  const append = (...children: unknown[]) => {
    for (const child of children) {
      detach(child);
      if (typeof child === "object" && child !== null) parents.set(child, node);
      node.children.push(child);
    }
  };
  Object.defineProperties(element, {
    childNodes: { get: () => [...node.children] },
    append: { value: append },
    replaceChildren: {
      value: (...children: unknown[]) => {
        for (const child of node.children) if (typeof child === "object" && child !== null) parents.delete(child);
        node.children = [];
        append(...children);
      },
    },
    remove: { value: () => detach(element) },
    isConnected: { value: false, writable: true },
    ownerDocument: { value: testDocument },
  });
  return element;
}

const testDocument = {
  createElement(tag: string): HTMLElement {
    const Element = customElements.get(tag);
    return testDom(Element ? new Element() : new TestElement());
  },
};

/** An element with `testDom`'s parts. */
export function testElement(attributes: Record<string, string> = {}): HTMLElement {
  const element = testDom(new TestElement());
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

/** What a light-DOM element connecting or disconnecting does, for an element `testDom` made. */
export function setConnected(element: HTMLElement & { connectedCallback(): void; disconnectedCallback(): void }, connected: boolean): void {
  Reflect.set(element, "isConnected", connected);
  if (connected) element.connectedCallback();
  else element.disconnectedCallback();
}
