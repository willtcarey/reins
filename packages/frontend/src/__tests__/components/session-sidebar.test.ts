import { afterEach, describe, expect, test } from "bun:test";
import { SessionSidebar } from "../../components/session-sidebar.js";
import { templateToString } from "../helpers/lit-template.js";

const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

function installViewportGlobals(options: { mobile: boolean; innerWidth: number }) {
  Reflect.set(globalThis, "navigator", { standalone: false });
  Reflect.set(globalThis, "window", {
    innerWidth: options.innerWidth,
    matchMedia: (query: string) => ({
      matches: query.includes("max-width") ? options.mobile : false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
}

afterEach(() => {
  Reflect.set(globalThis, "window", originalWindow);
  Reflect.set(globalThis, "navigator", originalNavigator);
});

describe("SessionSidebar viewport behavior", () => {
  test("uses the viewport controller mobile state instead of reading window width", () => {
    installViewportGlobals({ mobile: true, innerWidth: 1024 });

    const el = new SessionSidebar();
    Reflect.set(el, "collapsed", true);

    expect(templateToString(el.render())).toContain("w-full md:w-64");

    Reflect.set(el, "collapsed", false);
    Reflect.get(el, "toggleCollapse").call(el);

    expect(Reflect.get(el, "collapsed")).toBe(false);
  });
});
