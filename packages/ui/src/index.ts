/**
 * `@reins/ui`, as the vendor build gives it to the page (its contract and how extensions use it: ../ui.d.ts;
 * docs/dev/extension-loading.md *Provided libraries*).
 */
import { ReinsBadge } from "./badge.js";
import { ReinsSidebarRow } from "./sidebar-row.js";

const ELEMENTS: [string, CustomElementConstructor][] = [
  ["reins-badge", ReinsBadge],
  ["reins-sidebar-row", ReinsSidebarRow],
];

/** Elements the app defines globally from its own code, before extensions load. The kit only hands a scoped
 * registry the app's class, so their code stays in the app's bundle and the kit carries none of it. */
const APP_ELEMENTS = ["reins-markdown"];

export function define(registry: CustomElementRegistry | null): void {
  const target = registry ?? customElements;
  const elements = registry ? [...ELEMENTS, ...appElements()] : ELEMENTS;
  for (const [name, element] of elements) {
    if (target.get(name)) continue;
    // A registry may refuse a constructor another registry has: each scoped one gets a subclass of its own.
    target.define(name, registry ? class extends element {} : element);
  }
}

function appElements(): [string, CustomElementConstructor][] {
  return APP_ELEMENTS.flatMap((name) => {
    const element = customElements.get(name);
    return element ? [[name, element]] : [];
  });
}

define(null);
