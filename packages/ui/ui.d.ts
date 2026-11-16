/**
 * `@reins/ui`: Reins' components for what an extension draws itself. The page provides this module through its
 * import map, as it provides Lit, so leave it out of your bundle (`--external @reins/ui`): what you get at run time
 * is the running Reins' code and look, which changes with Reins and never needs your rebuild.
 *
 * Use it from any framework, or none: import it once (`import "@reins/ui"`), which defines the elements in the page's
 * global registry, and write the elements with attributes (every one has an attribute; Svelte sets the properties of
 * the same names). It needs no Lit in your code. Only a Lit extension whose templates create elements through
 * `@reins/sdk/lit`'s scoped registry calls `define(registry)` too, as that registry does not see the global one.
 * The elements draw in the light DOM, with Reins' rules low in the cascade (the page's `components` layer): your own
 * CSS restyles them when you mean it to. Their colors and sizes are Reins' design tokens.
 *
 * This file is the contract (part of an SDK version); `src/` implements it (checked by `src/contract.ts`).
 */

export type BadgeTone = "attention" | "info" | "neutral";

/**
 * `<reins-badge>`: a count or short text in a pill. Not drawn (`display: none`) while `value` is empty, null, 0 or
 * "0", so a count of 0 needs no condition. Its native `title` attribute is its tooltip.
 */
export interface ReinsBadgeElement extends HTMLElement {
  /** Attribute `value`. */
  value: string | number | null;
  /** Attribute `tone`: `attention` (amber, the user is needed), `info` (blue), `neutral` (grey, the default). */
  tone: BadgeTone;
  /** Attribute `icon`: an SVG's markup, drawn at 10px before the value in the badge's color (`currentColor`). */
  icon: string | null;
}

/**
 * `<reins-sidebar-row>`: a sidebar section's row that opens something: an icon, a label, and its badges (the
 * `<reins-badge>` children, drawn after its button) on the right. Listen for `click` on the row.
 */
export interface ReinsSidebarRowElement extends HTMLElement {
  /** Attribute `label`: the text it shows. */
  label: string;
  /** Attribute `icon`: an SVG's markup, drawn at 14px before the label (`currentColor`). */
  icon: string | null;
  /** Attribute `current`: what it opens is shown now. The button has `aria-current="page"` then. */
  current: boolean;
  /** Attribute `accessible-label`: what assistive technology reads for the button instead of `label` (give the
   * counts the badges show, in words). */
  accessibleLabel: string | null;
}

/** Defines the elements in `registry` (a scoped one, such as `@reins/sdk/lit`'s `registry`); null is the global
 * registry, where importing the module defines them. A name already defined there is left as it is. */
export function define(registry: CustomElementRegistry | null): void;

declare global {
  interface HTMLElementTagNameMap {
    "reins-badge": ReinsBadgeElement;
    "reins-sidebar-row": ReinsSidebarRowElement;
  }
}
