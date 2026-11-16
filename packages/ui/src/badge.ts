import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { BadgeTone } from "../ui.d.ts";
import { LightElement } from "./light-element.js";

const empty = (value: string | number | null) => value === null || value === "" || value === 0 || value === "0";

export class ReinsBadge extends LightElement {
  // Reflected: kit.css colors and hides it by these attributes.
  static override properties = {
    value: { reflect: true },
    tone: { reflect: true },
    icon: {},
  };

  declare value: string | number | null;
  declare tone: BadgeTone;
  declare icon: string | null;

  constructor() {
    super();
    this.value = null;
    this.tone = "neutral";
    this.icon = null;
  }

  override render() {
    if (empty(this.value)) return nothing;
    return html`${this.icon ? html`<span class="reins-badge-icon inline-flex size-2.5 shrink-0 [&>svg]:block [&>svg]:size-full" aria-hidden="true">${unsafeHTML(this.icon)}</span>` : nothing}${this.value}`;
  }
}
