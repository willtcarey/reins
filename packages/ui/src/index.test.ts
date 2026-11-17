import { expect, test } from "bun:test";
import { define } from "@reins/ui";

/** A scoped registry, which happy-dom cannot construct. */
function stubRegistry() {
  const entries = new Map<string, CustomElementConstructor>();
  return Object.assign(Object.create(CustomElementRegistry.prototype), {
    get: (name: string) => entries.get(name),
    define: (name: string, element: CustomElementConstructor) => {
      if (entries.has(name)) throw new Error(`${name} is defined`);
      entries.set(name, element);
    },
  });
}

test("importing it defines the elements globally; define(registry) defines them in a scoped registry once", () => {
  const Badge = customElements.get("reins-badge")!;
  const Row = customElements.get("reins-sidebar-row")!;
  const registry = stubRegistry();

  define(registry);
  define(registry);
  define(null);

  expect(registry.get("reins-badge").prototype).toBeInstanceOf(Badge);
  expect(registry.get("reins-sidebar-row").prototype).toBeInstanceOf(Row);
  expect(customElements.get("reins-badge")).toBe(Badge);
});

test("define(registry) gives a scoped registry the elements the app defines globally, as subclasses of the app's", () => {
  // What the app defines from its own code at startup, before extensions load.
  class AppMarkdown extends HTMLElement {}
  customElements.define("reins-markdown", AppMarkdown);
  const registry = stubRegistry();

  define(registry);
  define(registry);

  expect(registry.get("reins-markdown").prototype).toBeInstanceOf(AppMarkdown);
  expect(registry.get("reins-markdown")).not.toBe(AppMarkdown);
  expect(customElements.get("reins-markdown")).toBe(AppMarkdown);
});
