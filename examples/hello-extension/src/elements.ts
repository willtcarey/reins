/**
 * This extension's own custom element registry. A page's global registry binds a tag to one class for the page's
 * life, and a reload of the extension evaluates this module anew with new classes; it would also share tags
 * with Reins and other extensions. So each evaluation of this module makes a registry of its own
 * (`new CustomElementRegistry()`, scoped registries: Chrome 146, Safari 26, Firefox 159), defines the extension's
 * elements there under their plain names, and creates them through it. Reins knows nothing of it: it is the
 * extension's own code.
 *
 * Lit clones its templates with `document.importNode`, which uses the global registry, so the extension's elements
 * give Lit a `creationScope` that clones through this registry.
 *
 * In a browser without scoped registries, the elements go in the global registry under a tag unique to this
 * evaluation (`hello-settings-k3x9…`), which works the same apart from the names.
 *
 * Its styles need nothing here: Reins scopes its stylesheet (`reins.styles` in package.json) to the elements it
 * mounts its views in.
 */
import { LitElement } from "lit";

type ScopedDocument = Document & {
  createElement(tag: string, options: { customElementRegistry: CustomElementRegistry }): HTMLElement;
  importNode(node: Node, options: { customElementRegistry: CustomElementRegistry; selfOnly: boolean }): Node;
};

function scopedRegistry(): CustomElementRegistry | null {
  try {
    return Reflect.construct(CustomElementRegistry, []);
  } catch {
    return null;
  }
}

const registry = scopedRegistry();
const scopedDocument = (): ScopedDocument => Object.assign(document);
/** What Lit clones templates with: through the extension's registry when it has one. */
const creationScope = registry
  ? { importNode: (node: Node, deep?: boolean) => scopedDocument().importNode(node, { customElementRegistry: registry, selfOnly: !deep }) }
  : undefined;
const suffix = registry ? "" : `-${Math.random().toString(36).slice(2, 10)}`;

/** Defines `element` under `name` (in the global registry only as the fallback, with this evaluation's suffix);
 * returns the tag to create it with. */
export function defineElement(name: string, element: CustomElementConstructor): string {
  const tag = `${name}${suffix}`;
  (registry ?? customElements).define(tag, element);
  return tag;
}

/** A new element of `tag`, made through the extension's registry. */
export function createElement(tag: string): HTMLElement {
  return registry ? scopedDocument().createElement(tag, { customElementRegistry: registry }) : document.createElement(tag);
}

/** The extension's elements: their templates' elements made through its registry, drawn in the light DOM, where
 * its scoped styles and the app's reach them. */
export class ScopedElement extends LitElement {
  constructor() {
    super();
    if (creationScope) this.renderOptions.creationScope = creationScope;
  }

  override createRenderRoot() {
    return this;
  }
}

/** Mounts a new element of `tag`, set up by `setup`, into `target` (the element Reins mounts the view in). */
export function mountElement<T extends HTMLElement>(target: HTMLElement, tag: string, type: abstract new () => T, setup: (element: T) => void) {
  const element = createElement(tag);
  if (element instanceof type) setup(element);
  target.append(element);
  return { dispose: () => element.remove() };
}
