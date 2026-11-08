import { describe, expect, test } from "bun:test";
import type { ExtensionView } from "@backend/extension-system/report.js";
import type { ReinsSdk } from "@reins/sdk";
import { Extensions } from "../../extension-system/extensions.js";
import { testSdk } from "../helpers/reins-sdk.js";

function added(name: string, build: string | null, overrides: Partial<ExtensionView> = {}): ExtensionView {
  return {
    name,
    status: "loaded",
    failure: null,
    source: { kind: "path", path: `/src/${name}` },
    manifest: { label: `${name} label`, description: `${name} description`, version: "1.0.0", icon: null },
    backendPart: true,
    frontendFailure: null,
    build: build ? { id: build, frontend: { script: `/extension-bundles/${name}/${build}/frontend.js?g=0`, styles: null } } : null,
    errors: [],
    registrations: { tools: null, promptSections: 0, settlementListeners: 0, scriptFunctions: [], httpMethods: [], pages: [] },
    services: [],
    storage: null,
    ...overrides,
  };
}

/** Modules by URL: each a register function that registers a Settings page and records its calls. */
function modules(calls: string[]) {
  return async (url: string) => ({
    default: (reins: ReinsSdk) => {
      calls.push(`register ${url}`);
      const dispose = reins.settings.register({ mount: () => ({}) });
      return () => {
        calls.push(`dispose ${url}`);
        dispose();
      };
    },
  });
}

/** The broken extension's module does not parse; the others' default export is no function. */
async function oddModules(url: string) {
  if (url.includes("/broken/")) throw new Error("Unexpected token");
  return { default: "not a function" };
}

/** The bad extension's register function throws; the others' load. */
async function throwingOnBad(url: string) {
  return { default: url.includes("/bad/") ? () => { throw new TypeError("x is not a function"); } : () => () => {} };
}

/** For an extension with no stylesheet: never called. */
async function noStyles(): Promise<() => void> {
  throw new Error("No stylesheet expected");
}

/** Enough of an element for a mount: what is appended to it, and the attributes of what it makes. */
function fakeTarget() {
  const children: { attributes: Record<string, string>; style: Record<string, string> }[] = [];
  const ownerDocument = {
    createElement: () => {
      const attributes: Record<string, string> = {};
      const style: Record<string, string> = {};
      return { attributes, style, setAttribute: (name: string, value: string) => { attributes[name] = value; } };
    },
  };
  return { target: Object.assign(Object.create(null), { ownerDocument, append: (child: (typeof children)[number]) => children.push(child) }), children };
}

/** Built-in parts that record their activation and disposal. */
function builtIns(calls: string[]) {
  return ["recent", "projects"].map(name => ({
    name,
    label: `${name} label`,
    register: () => {
      calls.push(`register ${name}`);
      return () => calls.push(`dispose ${name}`);
    },
  }));
}

describe("Extensions", () => {
  test("activates each added extension's frontend part of the report with its manifest's label, once per build", async () => {
    const sdk = testSdk();
    const calls: string[] = [];
    const frontends = new Extensions({ host: sdk.extensionHost, sdkFor: sdk.sdkFor, importModule: modules(calls), builtIns: [], reserved: new Set(), report: () => {}, addStyles: noStyles });

    await frontends.sync([added("spoke", "b1"), added("backend-only", "b2", { build: { id: "b2", frontend: null } })]);
    await frontends.sync([added("spoke", "b1")]);

    expect(calls).toEqual(["register /extension-bundles/spoke/b1/frontend.js?g=0"]);
    expect(sdk.extensionHost.list().map(({ extension, status }) => ({ name: extension.name, label: extension.label, description: extension.description, status }))).toEqual([
      { name: "spoke", label: "spoke label", description: "spoke description", status: "loaded" },
    ]);
    expect(sdk.settingsPages.page("spoke")).not.toBeNull();
  });

  test("a new build disposes the old part before activating the new one, and one turned off is disposed", async () => {
    const sdk = testSdk();
    const calls: string[] = [];
    const frontends = new Extensions({ host: sdk.extensionHost, sdkFor: sdk.sdkFor, importModule: modules(calls), builtIns: [], reserved: new Set(), report: () => {}, addStyles: noStyles });
    await frontends.sync([added("spoke", "b1")]);

    await frontends.sync([added("spoke", "b2")]);
    await frontends.sync([added("spoke", null, { status: "disabled" })]);

    expect(calls).toEqual([
      "register /extension-bundles/spoke/b1/frontend.js?g=0",
      "dispose /extension-bundles/spoke/b1/frontend.js?g=0",
      "register /extension-bundles/spoke/b2/frontend.js?g=0",
      "dispose /extension-bundles/spoke/b2/frontend.js?g=0",
    ]);
    expect(sdk.extensionHost.list()).toEqual([]);
    expect(sdk.settingsPages.page("spoke")).toBeNull();
  });

  test("a report that fails to apply does not stop the next ones", async () => {
    const sdk = testSdk();
    const calls: string[] = [];
    let broken = true;
    const sdkFor: typeof sdk.sdkFor = (extension, scope) => {
      if (broken) throw new Error("no SDK");
      return sdk.sdkFor(extension, scope);
    };
    const frontends = new Extensions({ host: sdk.extensionHost, sdkFor, importModule: modules(calls), builtIns: [], reserved: new Set(), report: () => {}, addStyles: noStyles });
    const originalError = console.error;
    console.error = () => {};

    try {
      await frontends.sync([added("spoke", "b1")]);
    } finally {
      console.error = originalError;
    }
    broken = false;
    await frontends.sync([added("spoke", "b2")]);

    expect(calls).toEqual(["register /extension-bundles/spoke/b2/frontend.js?g=0"]);
  });

  test("tells the server how each part loaded: null when it did, else the error with its stack", async () => {
    const sdk = testSdk();
    const reports: Array<[string, string, string | null]> = [];
    const originalError = console.error;
    console.error = () => {};
    const frontends = new Extensions({
      host: sdk.extensionHost, sdkFor: sdk.sdkFor, importModule: throwingOnBad, builtIns: [], reserved: new Set(),
      report: (name, script, error) => reports.push([name, script, error]), addStyles: noStyles,
    });

    try {
      await frontends.sync([added("good", "b1"), added("bad", "b1")]);
    } finally {
      console.error = originalError;
    }

    expect(reports[0]).toEqual(["good", "/extension-bundles/good/b1/frontend.js?g=0", null]);
    expect(reports[1]?.slice(0, 2)).toEqual(["bad", "/extension-bundles/bad/b1/frontend.js?g=0"]);
    expect(reports[1]?.[2]).toStartWith("TypeError: x is not a function\n    at ");
  });

  test("a module that cannot be imported, or that is no register function, and a name the app keeps are failed with why", async () => {
    const sdk = testSdk();
    const originalError = console.error;
    console.error = () => {};
    const frontends = new Extensions({ host: sdk.extensionHost, sdkFor: sdk.sdkFor, importModule: oddModules, builtIns: [], reserved: new Set(["app"]), report: () => {}, addStyles: noStyles });

    try {
      await frontends.sync([added("broken", "b1"), added("odd", "b1"), added("app", "b1")]);
    } finally {
      console.error = originalError;
    }

    expect(sdk.extensionHost.list().map(({ extension, status, error }) => ({ name: extension.name, status, error }))).toEqual([
      { name: "broken", status: "failed", error: "Its frontend module could not be loaded: Unexpected token" },
      { name: "odd", status: "failed", error: "Its frontend module's default export is not a register function" },
      { name: "app", status: "failed", error: "The app keeps the name app" },
    ]);
  });

  /** A built-in extension as the server reports it. */
  const builtIn = (name: string, status: ExtensionView["status"]) =>
    added(name, null, { status, source: { kind: "built-in" }, manifest: null, backendPart: false });

  test("activates the built-in parts first, unless the report has one turned off; turned on again, it is activated again", async () => {
    const sdk = testSdk();
    const calls: string[] = [];
    const frontends = new Extensions({ host: sdk.extensionHost, sdkFor: sdk.sdkFor, importModule: modules(calls), builtIns: builtIns(calls), reserved: new Set(), report: () => {}, addStyles: noStyles });

    await frontends.sync([builtIn("recent", "loaded"), builtIn("projects", "disabled"), added("spoke", "b1")]);
    await frontends.sync([builtIn("recent", "disabled"), builtIn("projects", "loaded"), added("spoke", "b1")]);

    expect(calls).toEqual([
      "register recent",
      "register /extension-bundles/spoke/b1/frontend.js?g=0",
      "dispose recent",
      "register projects",
    ]);
    expect(sdk.extensionHost.list().map(({ extension }) => extension.label)).toEqual(["spoke label", "projects label"]);
  });

  test("a built-in part whose name the report gives an added extension is not activated: the added one is", async () => {
    const sdk = testSdk();
    const calls: string[] = [];
    const frontends = new Extensions({ host: sdk.extensionHost, sdkFor: sdk.sdkFor, importModule: modules(calls), builtIns: builtIns(calls), reserved: new Set(), report: () => {}, addStyles: noStyles });

    await frontends.sync([added("recent", "b1")]);

    expect(calls).toEqual(["register projects", "register /extension-bundles/recent/b1/frontend.js?g=0"]);
  });

  test("an added extension mounts inside its scope, and its stylesheet is linked before it registers and unlinked after it is disposed", async () => {
    const sdk = testSdk();
    const calls: string[] = [];
    const styles = "/extension-bundles/spoke/b1/~styles.css";
    const addStyles = async (name: string, url: string) => {
      calls.push(`link ${name} ${url}`);
      return () => { calls.push(`unlink ${url}`); };
    };
    const frontends = new Extensions({ host: sdk.extensionHost, sdkFor: sdk.sdkFor, importModule: modules(calls), builtIns: [], reserved: new Set(), report: () => {}, addStyles });

    await frontends.sync([added("spoke", "b1", { build: { id: "b1", frontend: { script: "/extension-bundles/spoke/b1/frontend.js?g=0", styles } } })]);
    const { target, children } = fakeTarget();
    sdk.settingsPages.page("spoke")?.settings.mount(target);
    await frontends.sync([]);

    expect(children.map(child => ({ attributes: child.attributes, display: child.style.display }))).toEqual([{ attributes: { "data-reins-extension": "spoke" }, display: "contents" }]);
    expect(calls).toEqual([`link spoke ${styles}`, "register /extension-bundles/spoke/b1/frontend.js?g=0", "dispose /extension-bundles/spoke/b1/frontend.js?g=0", `unlink ${styles}`]);
  });
});
