import { describe, expect, test } from "bun:test";
import { SCOPE_ATTRIBUTE as SDK_SCOPE_ATTRIBUTE } from "@reins/sdk";
import { SCOPE_ATTRIBUTE, scopeStyles, StylesError } from "../../extension-system/styles.js";

const SCOPE = ":where([data-reins-extension=spoke])";

/** The scoped sheet, a rule a line. */
function scoped(css: string): string[] {
  return scopeStyles(css, "spoke").replaceAll("}", "}\n").split("\n").filter(Boolean);
}

describe("scopeStyles", () => {
  test("every rule applies only inside the extension's scope, in layers and media queries too", () => {
    expect(scoped("@layer utilities { .p-2 { padding: 1px } @media (min-width: 40rem) { .sm\\:p-4 { padding: 2px } } } *, ::before { margin: 0 }")).toEqual([
      `@layer utilities{${SCOPE} .p-2{padding:1px}`,
      `@media (width>=40rem){${SCOPE} .sm\\:p-4{padding:2px}`,
      "}",
      "}",
      `${SCOPE} *,${SCOPE} :before{margin:0}`,
    ]);
  });

  test("the page's roots (:root, :host, html, body) mean the scope itself, so a theme's variables are set there", () => {
    expect(scoped(":root, :host { --c: red } html.dark .x { color: red } body > div { color: green }")).toEqual([
      `${SCOPE},${SCOPE}{--c:red}`,
      `${SCOPE}.dark .x{color:red}`,
      `${SCOPE}>div{color:green}`,
    ]);
  });

  test("nested rules, keyframes and font faces are left as they are", () => {
    expect(scoped(".a { & .b { color: red } } @keyframes spin { to { rotate: 1turn } } @font-face { font-family: X; src: url(x.woff2) }")).toEqual([
      `${SCOPE} .a{& .b{color:red}`,
      "}",
      "@keyframes spin{to{rotate:1turn}",
      "}",
      "@font-face{font-family:X;src:url(x.woff2)}",
    ]);
  });

  test("declarations are kept, Tailwind's calc()s too (minified)", () => {
    expect(scoped(".mt-2 { margin-top: calc(var(--spacing) * 2) }")).toEqual([`${SCOPE} .mt-2{margin-top:calc(var(--spacing)*2)}`]);
  });

  test("refuses a sheet that imports another, or cannot be read", () => {
    expect(() => scopeStyles("@import url(other.css); .a { color: red }", "spoke")).toThrow(new StylesError("Its stylesheet imports another: bundle it into one file"));
    expect(() => scopeStyles("..a { color: red }", "spoke")).toThrow(StylesError);
  });

  test("scopes with the attribute the SDK mounts extensions' views in", () => {
    expect(SCOPE_ATTRIBUTE).toBe(SDK_SCOPE_ATTRIBUTE);
  });
});
