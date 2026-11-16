import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { LightElement } from "./light-element.js";

/** The element is the row (kit.css); its button holds the icon and label, and its children, the badges, follow. A
 * click on any of it reaches the element, which is the row's press. */
export class ReinsSidebarRow extends LightElement {
  static override properties = {
    label: {},
    icon: {},
    current: { type: Boolean, reflect: true },
    accessibleLabel: { attribute: "accessible-label" },
  };

  declare label: string;
  declare icon: string | null;
  declare current: boolean;
  declare accessibleLabel: string | null;

  constructor() {
    super();
    this.label = "";
    this.icon = null;
    this.current = false;
    this.accessibleLabel = null;
  }

  override render() {
    return html`<button type="button" class="reins-sidebar-row-button flex min-w-0 flex-1 cursor-[inherit] items-center gap-2 text-left outline-none" aria-label=${this.accessibleLabel || this.label} aria-current=${this.current ? "page" : nothing}>${this.icon ? html`<span class="reins-sidebar-row-icon inline-flex size-3.5 shrink-0 text-muted [&>svg]:block [&>svg]:size-full" aria-hidden="true">${unsafeHTML(this.icon)}</span>` : nothing}<span class="reins-sidebar-row-label min-w-0 flex-1 truncate">${this.label}</span></button>`;
  }
}
