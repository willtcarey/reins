import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildRouter } from "../../routes/index.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { makeRequest } from "../helpers/request.js";
import type { ServerSdk } from "@reins/sdk/server";
import { BUILT_IN_EXTENSION_NAMES } from "../../extensions/built-in-names.js";
import { testExtensionBuildsDir, testExtensionsDir, useTestDb } from "../helpers/test-db.js";

const router = buildRouter();

async function request(state: TestAppState, method: string, path: string, body?: unknown) {
  return (await router.handle(makeRequest(method, path, body), state, { upgrade: () => false }))!;
}

/** An extension's directory as its author delivers it: its package.json with the manifest, and its built files. */
function extensionDir(files: Record<string, string>, manifest: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "reins-ext-"));
  const reins = { name: "greeter", label: "Greeter", sdk: "^0.1.0", backend: "./dist/server.js", ...manifest };
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "greeter", version: "1.2.0", reins }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

/** A built backend part: its migration, and one method, `hello`, which writes to its database. */
const GREETER_BACKEND = `
export default {
  migrations: [{ id: "001_greetings", up: db => db.exec("CREATE TABLE greetings (name TEXT)") }],
  register: reins => reins.http.handle({ hello: { output: {} } }, {
    hello: () => {
      reins.db.query("INSERT INTO greetings (name) VALUES ('Ada')").run();
      return "Hello";
    },
  }),
};
`;

/** A backend whose service logs its start and stop as `version`, and whose one method is `method`. */
function serviceBackend(version: string, method: string): string {
  return `
export default {
  register: reins => {
    const log = (globalThis.serviceLog ??= []);
    reins.services.register({ name: "poll", start: ({ signal }) => {
      log.push("start ${version}");
      signal.addEventListener("abort", () => log.push("stop ${version}"));
    } });
    return reins.http.handle({ ${method}: {} }, { ${method}: () => {} });
  },
};
`;
}

/** The report's added extensions: those not built in. */
async function addedViews(state: TestAppState): Promise<{ name: string; status: string; source: { kind: string } }[]> {
  const views: { name: string; status: string; source: { kind: string } }[] = await (await request(state, "GET", "/api/installed-extensions")).json();
  return views.filter(view => view.source.kind === "path");
}

/** The report's view of `name`. */
async function viewOf(state: TestAppState, name: string): Promise<Record<string, unknown> | undefined> {
  const views: { name: string }[] = await (await request(state, "GET", "/api/installed-extensions")).json();
  return views.find(view => view.name === name);
}

/** A built-in with a service that logs its start and stop, and one method, `now`. */
function builtIn(log: string[]) {
  return {
    name: "clock",
    register: (reins: ServerSdk) => {
      reins.services.register({ name: "tick", start: ({ signal }) => {
        log.push("start");
        signal.addEventListener("abort", () => log.push("stop"));
      } });
      return reins.http.handle({ now: {} }, { now: () => {} });
    },
  };
}

function recordingClients() {
  const frames: { type: string }[] = [];
  return { frames, clients: new Set([{ ws: { send: (frame: string) => { frames.push(JSON.parse(frame)); return 0; } } }]) };
}

describe("extensions", () => {
  useTestDb();

  describe("adding one", () => {
    test("an extension in a directory is loaded from its manifest and built files, and its frontend files are served as they are", async () => {
      const frontend = `import { html } from "lit";\nimport { part } from "./chunks/part.js";\nexport default () => () => {};\n`;
      const dir = extensionDir({
        "dist/server.js": GREETER_BACKEND,
        "dist/frontend.js": frontend,
        "dist/chunks/part.js": "export const part = 1;\n",
      }, { frontend: "./dist/frontend.js", description: "Says hello." });
      const { frames, clients } = recordingClients();
      const state = createAppState({ clients }, { extensions: [] });

      const added = await request(state, "POST", "/api/installed-extensions", { path: dir });

      expect(added.status).toBe(201);
      const view = await added.json();
      expect(view).toMatchObject({
        name: "greeter",
        status: "loaded",
        failure: null,
        source: { kind: "path", path: dir },
        manifest: { label: "Greeter", description: "Says hello.", version: "1.2.0", icon: null },
        registrations: { httpMethods: ["hello"] },
      });
      expect(frames).toContainEqual({ type: "extensions_changed" });
      expect(await (await request(state, "POST", "/api/extensions/greeter/hello")).json()).toBe("Hello");

      const base = `/extension-bundles/greeter/${view.build.id}`;
      expect(view.build.frontend).toEqual({ script: `${base}/frontend.js?g=0`, styles: null });
      const script = view.build.frontend.script;
      expect(await (await request(state, "GET", script)).text()).toBe(frontend);
      expect(await (await request(state, "GET", `${base}/chunks/part.js`)).text()).toBe("export const part = 1;\n");
      expect((await request(state, "GET", `${base}/server.js`)).status).toBe(404);
      expect((await request(state, "GET", `${base}/..%2Fpackage.json`)).status).toBe(404);
      expect((await request(state, "GET", `/extension-bundles/greeter/stale/frontend.js`)).status).toBe(404);
      expect((await request(state, "GET", script)).headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    });

    test("its stylesheet is scoped to its views when it is installed, and given with its frontend part", async () => {
      const dir = extensionDir({
        "dist/server.js": GREETER_BACKEND,
        "dist/frontend.js": "export default () => () => {};\n",
        "dist/styles.css": ":root { --c: red } .p-2 { padding: 1px }",
      }, { frontend: "./dist/frontend.js", styles: "./dist/styles.css" });
      const state = createAppState(undefined, { extensions: [] });

      const view = await (await request(state, "POST", "/api/installed-extensions", { path: dir })).json();

      expect(view.build.frontend.styles).toBe(`/extension-bundles/greeter/${view.build.id}/~styles.css`);
      const styles = await request(state, "GET", view.build.frontend.styles);
      expect(styles.headers.get("Content-Type")).toStartWith("text/css");
      expect(await styles.text()).toBe(":where([data-reins-extension=greeter]){--c:red}:where([data-reins-extension=greeter]) .p-2{padding:1px}");
    });

    test("a stylesheet that cannot be scoped fails it at install", async () => {
      const dir = extensionDir({ "dist/frontend.js": "", "dist/styles.css": "@import url(other.css);" }, { backend: undefined, frontend: "./dist/frontend.js", styles: "./dist/styles.css" });
      const state = createAppState(undefined, { extensions: [] });

      const view = await (await request(state, "POST", "/api/installed-extensions", { path: dir })).json();

      expect(view).toMatchObject({ status: "failed", failure: { stage: "load", message: "Its stylesheet imports another: bundle it into one file" } });
    });

    test("its built files are copied into Reins: it runs without its directory, and a rebuild takes effect when it is reloaded", async () => {
      const dir = extensionDir({ "dist/server.js": GREETER_BACKEND, "dist/frontend.js": "export default () => () => {};\n", "src/frontend.ts": "source" }, { frontend: "./dist/frontend.js" });
      const first = createAppState(undefined, { extensions: [] });
      const added = await (await request(first, "POST", "/api/installed-extensions", { path: dir })).json();
      expect(readdirSync(join(testExtensionBuildsDir(), "greeter"))).toEqual([added.build.id]);
      expect(existsSync(join(testExtensionBuildsDir(), "greeter", added.build.id, "src"))).toBe(false);

      writeFileSync(join(dir, "dist/frontend.js"), "export default () => () => {}; // rebuilt\n");
      expect(await (await request(first, "GET", added.build.frontend.script)).text()).toBe("export default () => () => {};\n");
      const reloaded = await (await request(first, "POST", "/api/installed-extensions/greeter/reload")).json();
      expect(await (await request(first, "GET", reloaded.build.frontend.script)).text()).toContain("rebuilt");
      expect(readdirSync(join(testExtensionBuildsDir(), "greeter"))).toEqual([reloaded.build.id]);
      await first.extensions.dispose();

      rmSync(dir, { recursive: true });
      const next = createAppState(undefined, { extensions: [] });
      await next.extensions.loaded;

      expect(await viewOf(next, "greeter")).toMatchObject({ status: "loaded", build: { id: reloaded.build.id } });
      expect(await (await request(next, "POST", "/api/extensions/greeter/hello")).json()).toBe("Hello");
      expect(await (await request(next, "GET", reloaded.build.frontend.script)).text()).toContain("rebuilt");
    });

    test("the host checks inputs against schemas made with the extension's own copy of TypeBox", async () => {
      const dir = extensionDir({});
      const build = Bun.spawnSync([process.execPath, "build", join(import.meta.dir, "../fixtures/added-extension/server.ts"), "--target", "bun", "--outfile", join(dir, "dist/server.js")]);
      expect(build.exitCode).toBe(0);
      const state = createAppState(undefined, { extensions: [] });
      await request(state, "POST", "/api/installed-extensions", { path: dir });

      const greeted = await request(state, "POST", "/api/extensions/greeter/hello", { name: "Ada" });
      const refused = await request(state, "POST", "/api/extensions/greeter/hello", { name: 1 });

      expect(await greeted.json()).toBe("Hello, Ada");
      expect(refused.status).toBe(400);
    });

    test("an extension whose built files are missing is failed and says to build it; the others load", async () => {
      const unbuilt = extensionDir({}, { name: "unbuilt", label: "Unbuilt", frontend: "./dist/frontend.js" });
      const greeter = extensionDir({ "dist/server.js": GREETER_BACKEND });
      const state = createAppState(undefined, { extensions: [] });

      const failed = await (await request(state, "POST", "/api/installed-extensions", { path: unbuilt })).json();
      await request(state, "POST", "/api/installed-extensions", { path: greeter });

      expect(failed).toMatchObject({
        name: "unbuilt",
        status: "failed",
        failure: { stage: "load", message: "Its backend file dist/server.js does not exist: build the extension first" },
        build: null,
      });
      expect((await addedViews(state)).map(({ name, status }) => ({ name, status }))).toEqual([{ name: "unbuilt", status: "failed" }, { name: "greeter", status: "loaded" }]);
    });

    test("a backend module that throws as it loads is failed with its error", async () => {
      const dir = extensionDir({ "dist/server.js": "throw new Error(\"no config\");\nexport default {};\n" });
      const state = createAppState(undefined, { extensions: [] });

      const view = await (await request(state, "POST", "/api/installed-extensions", { path: dir })).json();

      expect(view).toMatchObject({ status: "failed", failure: { stage: "load", message: "no config" } });
    });

    test("an extension with only a frontend part is loaded with nothing on the server: no backend part, no storage", async () => {
      const dir = extensionDir({ "dist/frontend.js": "export default () => () => {};" }, { backend: undefined, frontend: "./dist/frontend.js" });
      const state = createAppState(undefined, { extensions: [] });

      const view = await (await request(state, "POST", "/api/installed-extensions", { path: dir })).json();

      expect(view).toMatchObject({ status: "loaded", backendPart: false, storage: null, build: { frontend: { script: expect.stringContaining("/frontend.js") } } });
      expect(existsSync(join(testExtensionsDir(), "greeter"))).toBe(false);
    });

    test("adding refuses what is not an extension, and a name taken", async () => {
      const state = createAppState(undefined, { extensions: [], builtInNames: ["mcp"] });
      const plain = mkdtempSync(join(tmpdir(), "reins-ext-"));
      writeFileSync(join(plain, "package.json"), JSON.stringify({ name: "plain" }));
      const refused = async (path: string) => {
        const response = await request(state, "POST", "/api/installed-extensions", { path });
        return { status: response.status, error: (await response.json()).error };
      };

      expect(await refused("relative/dir")).toEqual({ status: 400, error: "Not an absolute path: relative/dir" });
      expect(await refused(plain)).toEqual({ status: 400, error: `${join(plain, "package.json")} has no "reins" key: it is not a Reins extension` });
      expect(await refused(extensionDir({}, { sdk: "^2.0.0" }))).toEqual({ status: 400, error: "It needs SDK ^2.0.0; this Reins provides 0.1.0" });
      expect(await refused(extensionDir({}, { name: "mcp" }))).toEqual({ status: 409, error: "mcp is the name of a built-in extension" });
      expect(await refused(extensionDir({}, { frontend: "./dist/frontend.js", styles: "./styles.css" }))).toEqual({ status: 400, error: "Its styles file styles.css must be in its frontend directory (dist)" });
      expect(await refused(extensionDir({}, { styles: "./dist/styles.css" }))).toEqual({ status: 400, error: "Its manifest names styles but no frontend: styles are for a frontend part's views" });
      expect(await refused(extensionDir({}, { frontend: "./frontend.js" }))).toEqual({ status: 400, error: "Its frontend file frontend.js must be in a directory of its own (such as dist/): Reins copies that whole directory" });
      await request(state, "POST", "/api/installed-extensions", { path: extensionDir({ "dist/server.js": GREETER_BACKEND }) });
      expect(await refused(extensionDir({ "dist/server.js": GREETER_BACKEND }))).toEqual({ status: 409, error: "An extension named greeter is already added" });
      expect(await addedViews(state)).toMatchObject([{ name: "greeter" }]);
    });
  });

  describe("loading at each app's start", () => {
    test("the next app loads every added extension", async () => {
      const dir = extensionDir({ "dist/server.js": GREETER_BACKEND });
      const first = createAppState(undefined, { extensions: [] });
      await request(first, "POST", "/api/installed-extensions", { path: dir });
      await first.extensions.dispose();

      const next = createAppState(undefined, { extensions: [] });
      await next.extensions.loaded;

      expect(await addedViews(next)).toMatchObject([{ name: "greeter", status: "loaded" }]);
      expect(await (await request(next, "POST", "/api/extensions/greeter/hello")).json()).toBe("Hello");
    });

    test("the next app loads the installed copy as it is, even when hashing it now would give another build ID", async () => {
      const dir = extensionDir({ "dist/server.js": GREETER_BACKEND });
      const first = createAppState(undefined, { extensions: [] });
      const added = await (await request(first, "POST", "/api/installed-extensions", { path: dir })).json();
      await first.extensions.dispose();
      const copy = join(testExtensionBuildsDir(), "greeter", added.build.id);
      writeFileSync(join(copy, "dist/server.js"), `${GREETER_BACKEND}\n// changed in place\n`);

      const next = createAppState(undefined, { extensions: [] });
      await next.extensions.loaded;

      expect(await viewOf(next, "greeter")).toMatchObject({ status: "loaded", build: { id: added.build.id } });
      expect(existsSync(copy)).toBe(true);
    });

    test("an app stopped while its added extensions load starts none of them", async () => {
      const dir = extensionDir({ "dist/server.js": GREETER_BACKEND });
      const first = createAppState(undefined, { extensions: [] });
      await request(first, "POST", "/api/installed-extensions", { path: dir });
      await first.extensions.dispose();

      const next = createAppState(undefined, { extensions: [] });
      await next.extensions.dispose();

      expect(await addedViews(next)).toEqual([]);
      expect((await request(next, "POST", "/api/extensions/greeter/hello")).status).toBe(404);
    });
  });

  describe("reloading", () => {
    test("reloading loads its files again: its services stop and start on the new code, its registrations are replaced and browsers are told", async () => {
      const log: string[] = [];
      Reflect.set(globalThis, "serviceLog", log);
      const dir = extensionDir({ "dist/server.js": serviceBackend("v1", "first"), "dist/frontend.js": "export default () => () => {};" }, { frontend: "./dist/frontend.js" });
      const { frames, clients } = recordingClients();
      const state = createAppState({ clients }, { extensions: [] });
      const before = await (await request(state, "POST", "/api/installed-extensions", { path: dir })).json();
      await Bun.sleep(10);
      writeFileSync(join(dir, "dist/server.js"), serviceBackend("v2", "second"));
      frames.length = 0;

      const after = await (await request(state, "POST", "/api/installed-extensions/greeter/reload")).json();

      await Bun.sleep(10);
      expect(log).toEqual(["start v1", "stop v1", "start v2"]);
      expect(after.registrations.httpMethods).toEqual(["second"]);
      expect((await request(state, "POST", "/api/extensions/greeter/first")).status).toBe(404);
      expect((await request(state, "POST", "/api/extensions/greeter/second")).status).toBe(204);
      expect(after.build.id).not.toBe(before.build.id);
      expect(after.build.frontend.script).toBe(`/extension-bundles/greeter/${after.build.id}/frontend.js?g=1`);
      expect(frames).toEqual([{ type: "extensions_changed" }]);
    });

    test("a reload that fails stays failed in the next apps, which do not run the build it was to replace", async () => {
      const dir = extensionDir({ "dist/server.js": GREETER_BACKEND });
      const first = createAppState(undefined, { extensions: [] });
      await request(first, "POST", "/api/installed-extensions", { path: dir });
      rmSync(join(dir, "dist/server.js"));
      const missing = { stage: "load", message: "Its backend file dist/server.js does not exist: build the extension first" };

      expect(await (await request(first, "POST", "/api/installed-extensions/greeter/reload")).json()).toMatchObject({ status: "failed", failure: missing });
      await first.extensions.dispose();
      const next = createAppState(undefined, { extensions: [] });
      await next.extensions.loaded;

      expect(await viewOf(next, "greeter")).toMatchObject({ status: "failed", failure: missing });
      expect((await request(next, "POST", "/api/extensions/greeter/hello")).status).toBe(404);
      writeFileSync(join(dir, "dist/server.js"), GREETER_BACKEND);
      expect(await (await request(next, "POST", "/api/installed-extensions/greeter/reload")).json()).toMatchObject({ status: "loaded" });
    });
  });

  describe("turning one off and on", () => {
    test("a built-in extension turned off stops and stays off in the next app until it is turned on", async () => {
      const log: string[] = [];
      const { frames, clients } = recordingClients();
      const state = createAppState({ clients }, { extensions: [builtIn(log)] });
      await Bun.sleep(5);

      const off = await request(state, "PATCH", "/api/installed-extensions/clock", { enabled: false });

      expect(off.status).toBe(204);
      expect(log).toEqual(["start", "stop"]);
      expect(frames).toContainEqual({ type: "extensions_changed" });
      expect((await request(state, "POST", "/api/extensions/clock/now")).status).toBe(404);
      expect(await viewOf(state, "clock")).toMatchObject(
        { status: "disabled", source: { kind: "built-in" }, backendPart: true, registrations: { httpMethods: [] }, services: [], storage: null },
      );
      await state.extensions.dispose();

      const next = createAppState(undefined, { extensions: [builtIn(log)] });
      await Bun.sleep(5);
      expect(log).toEqual(["start", "stop"]);
      expect((await request(next, "PATCH", "/api/installed-extensions/clock", { enabled: true })).status).toBe(204);
      await Bun.sleep(5);
      expect(log).toEqual(["start", "stop", "start"]);
      expect(await viewOf(next, "clock")).toMatchObject({ status: "loaded" });
      expect((await request(next, "POST", "/api/extensions/clock/now")).status).toBe(204);
    });

    test("an added extension turned off is unloaded, cannot be reloaded, and loads again when turned on", async () => {
      const dir = extensionDir({ "dist/server.js": GREETER_BACKEND, "dist/frontend.js": "export default () => () => {};" }, { frontend: "./dist/frontend.js" });
      const state = createAppState(undefined, { extensions: [] });
      await request(state, "POST", "/api/installed-extensions", { path: dir });

      await request(state, "PATCH", "/api/installed-extensions/greeter", { enabled: false });

      expect(await addedViews(state)).toMatchObject([
        { name: "greeter", status: "disabled", source: { kind: "path", path: dir }, manifest: { label: "Greeter" }, build: null, backendPart: true },
      ]);
      expect((await request(state, "POST", "/api/extensions/greeter/hello")).status).toBe(404);
      const reload = await request(state, "POST", "/api/installed-extensions/greeter/reload");
      expect({ status: reload.status, error: (await reload.json()).error }).toEqual({ status: 409, error: "greeter is turned off: turn it on first" });
      await state.extensions.dispose();

      const next = createAppState(undefined, { extensions: [] });
      await next.extensions.loaded;
      expect(await addedViews(next)).toMatchObject([{ name: "greeter", status: "disabled" }]);
      await request(next, "PATCH", "/api/installed-extensions/greeter", { enabled: true });
      expect(await addedViews(next)).toMatchObject([{ name: "greeter", status: "loaded", build: { frontend: {} } }]);
      expect(await (await request(next, "POST", "/api/extensions/greeter/hello")).json()).toBe("Hello");
    });
  });

  describe("removing one", () => {
    test("removing one unloads it and forgets it and its copied files, and keeps its data", async () => {
      const dir = extensionDir({ "dist/server.js": GREETER_BACKEND });
      const state = createAppState(undefined, { extensions: [] });
      await request(state, "POST", "/api/installed-extensions", { path: dir });

      const removed = await request(state, "DELETE", "/api/installed-extensions/greeter");

      expect(removed.status).toBe(204);
      expect(await addedViews(state)).toEqual([]);
      expect((await request(state, "POST", "/api/extensions/greeter/hello")).status).toBe(404);
      expect(existsSync(join(testExtensionsDir(), "greeter", "db.sqlite"))).toBe(true);
      expect(existsSync(join(testExtensionBuildsDir(), "greeter"))).toBe(false);
      expect((await request(state, "POST", "/api/installed-extensions/greeter/reload")).status).toBe(404);
    });

    test("a built-in extension cannot be removed, and an unknown one is not found", async () => {
      const state = createAppState(undefined, { extensions: [], builtInNames: ["file-viewer"] });

      const removed = await request(state, "DELETE", "/api/installed-extensions/file-viewer");
      const unknown = await request(state, "PATCH", "/api/installed-extensions/nothing", { enabled: false });

      expect({ status: removed.status, error: (await removed.json()).error }).toEqual({ status: 400, error: "file-viewer is built in: turn it off instead" });
      expect(unknown.status).toBe(404);
    });
  });

  describe("built-in extensions", () => {
    test("every built-in extension is in the report, one with only a frontend part too, which can be turned off", async () => {
      const state = createAppState(undefined, { extensions: [], builtInNames: BUILT_IN_EXTENSION_NAMES });
      const names = (await (await request(state, "GET", "/api/installed-extensions")).json()).map((view: { name: string }) => view.name);
      const on = await viewOf(state, "file-viewer");

      await request(state, "PATCH", "/api/installed-extensions/file-viewer", { enabled: false });
      const off = await viewOf(state, "file-viewer");
      await request(state, "PATCH", "/api/installed-extensions/file-viewer", { enabled: true });

      const frontendOnly = { source: { kind: "built-in" }, backendPart: false, storage: null, registrations: { httpMethods: [] } };
      expect(on).toMatchObject({ status: "loaded", ...frontendOnly });
      expect(off).toMatchObject({ status: "disabled", ...frontendOnly });
      expect(await viewOf(state, "file-viewer")).toMatchObject({ status: "loaded" });
      expect(names).toEqual([...BUILT_IN_EXTENSION_NAMES]);
    });
  });

  describe("the browser's report", () => {
    test("a browser reports how its frontend part loaded: a failure is in the report until a browser loads it or it is reloaded; a stale build's report is ignored", async () => {
      const dir = extensionDir({ "dist/server.js": GREETER_BACKEND, "dist/frontend.js": "export default () => () => {};" }, { frontend: "./dist/frontend.js" });
      const state = createAppState(undefined, { extensions: [] });
      const { build } = await (await request(state, "POST", "/api/installed-extensions", { path: dir })).json();
      const report = (script: string, error: string | null) => request(state, "POST", "/api/installed-extensions/greeter/frontend", { script, error });
      const frontendFailure = async () => (await viewOf(state, "greeter"))?.frontendFailure;

      expect((await report(build.frontend.script, "TypeError: x is not a function\n    at register (frontend.js:3:1)")).status).toBe(204);
      expect(await frontendFailure()).toEqual({ message: "TypeError: x is not a function\n    at register (frontend.js:3:1)", at: expect.stringMatching(/^\d{4}-/) });
      await report("/extension-bundles/greeter/old/frontend.js?g=0", null);
      expect(await frontendFailure()).not.toBeNull();
      await report(build.frontend.script, null);
      expect(await frontendFailure()).toBeNull();

      await report(build.frontend.script, "broken");
      await request(state, "POST", "/api/installed-extensions/greeter/reload");
      expect(await frontendFailure()).toBeNull();
    });
  });
});
