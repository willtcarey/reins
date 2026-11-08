/**
 * `@reins/sdk/lit`: custom elements for an extension's Lit frontend part. Bundle it (it is the extension's own
 * code once built); leave `lit` external, as the page provides it.
 *
 * The page's global registry binds a tag to one class for the page's life, and a reload evaluates the extension's
 * bundle anew with new classes; its tags would also clash with Reins' and other extensions'. So each evaluation of
 * this module, one for each bundle and each reload, makes a registry of its own (`new CustomElementRegistry()`,
 * scoped registries: Chrome 146, Safari 26, Firefox 159), and the extension defines and creates its elements
 * through it. Lit clones its templates with `document.importNode`, which uses the global registry, so
 * `ScopedElement` gives Lit a `creationScope` that clones through this one. In a browser without scoped
 * registries the elements go in the global registry under tags unique to this evaluation (`hello-settings-k3x9…`).
 *
 * Elements draw in the light DOM: the extension's scoped stylesheet and the app's styles reach them there.
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
const creationScope = registry
  ? { importNode: (node: Node, deep?: boolean) => scopedDocument().importNode(node, { customElementRegistry: registry, selfOnly: !deep }) }
  : undefined;
const suffix = registry ? "" : `-${Math.random().toString(36).slice(2, 10)}`;

/** Defines `element` under `name`; returns the tag to create it with, which differs from `name` in an older browser. */
export function defineElement(name: string, element: CustomElementConstructor): string {
  const tag = `${name}${suffix}`;
  (registry ?? customElements).define(tag, element);
  return tag;
}

export function createElement(tag: string): HTMLElement {
  return registry ? scopedDocument().createElement(tag, { customElementRegistry: registry }) : document.createElement(tag);
}

/** The base of an extension's Lit elements: the elements in its templates are made through the registry, and it
 * draws in the light DOM. */
export class ScopedElement extends LitElement {
  constructor() {
    super();
    if (creationScope) this.renderOptions.creationScope = creationScope;
  }

  override createRenderRoot() {
    return this;
  }
}

/** A mount function's body: a new element of `tag`, set up by `setup`, in `target` (the element Reins mounts the
 * view in), and its disposal. */
export function mountElement<T extends HTMLElement>(target: HTMLElement, tag: string, type: abstract new () => T, setup: (element: T) => void) {
  const element = createElement(tag);
  if (element instanceof type) setup(element);
  target.append(element);
  return { dispose: () => element.remove() };
}
