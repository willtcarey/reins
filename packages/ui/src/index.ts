/**
 * `@reins/ui`, as the vendor build gives it to the page (its contract and how extensions use it: ../ui.d.ts;
 * docs/dev/extension-loading.md *Provided libraries*).
 */
import type { LitElement } from "lit";
import { ReinsBadge } from "./badge.js";
import { ReinsSidebarRow } from "./sidebar-row.js";

const ELEMENTS: [string, typeof LitElement][] = [
  ["reins-badge", ReinsBadge],
  ["reins-sidebar-row", ReinsSidebarRow],
];

export function define(registry: CustomElementRegistry | null): void {
  for (const [name, element] of ELEMENTS) {
    const target = registry ?? customElements;
    if (target.get(name)) continue;
    // A registry may refuse a constructor another registry has: each scoped one gets a subclass of its own.
    target.define(name, registry ? class extends element {} : element);
  }
}

define(null);
