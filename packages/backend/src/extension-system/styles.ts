/**
 * Scopes an added extension's stylesheet to its views (docs/dev/extension-loading.md *Styles*): every rule
 * applies only inside the elements Reins mounts it in (`data-reins-extension="<name>"`), so it cannot restyle
 * the app or another extension, while the app's styles still reach in. `:where()` adds no specificity, so its
 * utilities weigh what the app's do.
 */

import { transform, type Selector, type SelectorComponent } from "lightningcss";

/** The SDK's `SCOPE_ATTRIBUTE` (a test checks it): the server imports nothing of the frontend's SDK at runtime. */
export const SCOPE_ATTRIBUTE = "data-reins-extension";

export class StylesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StylesError";
  }
}

export function scopeStyles(css: string, name: string): string {
  const scope: SelectorComponent = { type: "attribute", name: SCOPE_ATTRIBUTE, operation: { operator: "equal", value: name } };
  let output: Uint8Array;
  try {
    output = transform({
      filename: "styles.css",
      code: Buffer.from(css),
      minify: true,
      // Selectors only: lightningcss cannot read back every declaration it gives a visitor (Tailwind's calc()s).
      visitor: {
        Selector: selector => scopeSelector(selector, scope),
        Rule: { import: () => { throw new StylesError("Its stylesheet imports another: bundle it into one file"); } },
      },
    }).code;
  } catch (error) {
    if (error instanceof StylesError) throw error;
    throw new StylesError(`Its stylesheet cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return new TextDecoder().decode(output);
}

/**
 * `:root`, `:host`, `html` and `body` are the page's: in an extension's sheet they mean its scope. One with a
 * state (`html.dark`, `:root[data-theme="dark"]`, `:host(.dark)`) keeps it on the page's root, which is what
 * has it, and applies inside the scope under it.
 */
function scopeSelector(selector: Selector, scope: SelectorComponent): Selector {
  // A nested rule's selector (`&` …) is relative to its parent's, which is scoped already.
  if (selector.some(component => component.type === "nesting")) return selector;
  const descendant: SelectorComponent = { type: "combinator", value: "descendant" };
  const end = selector.findIndex(component => component.type === "combinator");
  const head = end < 0 ? selector : selector.slice(0, end);
  const rest = selector.slice(head.length);
  if (!head.some(isPageRoot)) return [where([scope]), descendant, ...selector];
  const qualifiers = head.flatMap(component => isPageRoot(component) ? hostArgument(component) : [component]);
  const state = qualifiers.filter(component => component.type !== "pseudo-element");
  const pseudoElements = qualifiers.filter(component => component.type === "pseudo-element");
  if (state.length === 0) return [where([scope]), ...pseudoElements, ...rest];
  const root = head.filter(isPageRoot).map(component => component.type === "pseudo-class" && component.kind === "host" ? ROOT : component);
  return [where([...root, ...state, descendant, scope]), ...pseudoElements, ...rest];
}

const ROOT: SelectorComponent = { type: "pseudo-class", kind: "root" };

/** No specificity: its utilities weigh what the app's do. */
function where(selector: Selector): SelectorComponent {
  return { type: "pseudo-class", kind: "where", selectors: [selector] };
}

/** `:host(.dark)`'s `.dark`. */
function hostArgument(component: SelectorComponent): Selector {
  return component.type === "pseudo-class" && component.kind === "host" ? component.selectors ?? [] : [];
}

function isPageRoot(component: SelectorComponent): boolean {
  return (component.type === "pseudo-class" && (component.kind === "root" || component.kind === "host"))
    || (component.type === "type" && (component.name === "html" || component.name === "body"));
}
