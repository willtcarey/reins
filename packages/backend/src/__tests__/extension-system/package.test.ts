import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installPackage, openPackage, PackageFailure } from "../../extension-system/package.js";

/** A package directory: its manifest, and `files` as its author's build wrote them. */
function packageDir(files: Record<string, string>, manifest: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "reins-pkg-"));
  const reins = { name: "greeter", label: "Greeter", sdk: "^0.1.0", backend: "./dist/server.js", frontend: "./dist/frontend.js", ...manifest };
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "greeter", version: "1.0.0", reins }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

async function failure(promise: Promise<unknown>): Promise<PackageFailure> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  if (!(error instanceof PackageFailure)) throw new Error(`Expected a PackageFailure, got ${String(error)}`);
  return error;
}

describe("openPackage", () => {
  test("gives its build ID, its frontend entry, and only the files of its frontend directory", async () => {
    const dir = packageDir({
      "dist/server.js": "export default { register: () => {} };",
      "dist/frontend.js": "export default () => {};",
      "dist/chunks/a b.js": "export const a = 1;",
      "secret.txt": "no",
    });

    const pkg = await openPackage(dir, "greeter");

    expect(pkg.buildId).toMatch(/^[0-9a-f]{16}$/);
    expect(pkg.frontendEntry).toBe("frontend.js");
    expect(await pkg.file("chunks/a b.js")).toBe(join(dir, "dist/chunks/a b.js"));
    expect(await pkg.file("server.js")).toBeNull();
    expect(await pkg.file("../secret.txt")).toBeNull();
    expect(await pkg.file("chunks")).toBeNull();
    expect(await pkg.file("missing.js")).toBeNull();
  });

  test("its build ID changes with its built files", async () => {
    const dir = packageDir({ "dist/server.js": "export default { register: () => {} };", "dist/frontend.js": "1" });
    const before = (await openPackage(dir, "greeter")).buildId;
    writeFileSync(join(dir, "dist/frontend.js"), "2");

    expect((await openPackage(dir, "greeter")).buildId).not.toBe(before);
  });

  test("fails at manifest for another name, and at load, with its manifest, for missing files or a module that is no extension", async () => {
    const built = packageDir({ "dist/server.js": "export default {};", "dist/frontend.js": "" });

    const renamed = await failure(openPackage(built, "other"));
    const unbuilt = await failure(openPackage(packageDir({}), "greeter"));
    const odd = await failure((await openPackage(built, "greeter")).importBackend());

    expect({ stage: renamed.stage, message: renamed.message }).toEqual({ stage: "manifest", message: "Its manifest now names it greeter: remove other and add it again" });
    expect({ stage: unbuilt.stage, message: unbuilt.message, label: unbuilt.manifest?.label }).toEqual({
      stage: "load", message: "Its backend file dist/server.js does not exist: build the extension first", label: "Greeter",
    });
    expect({ stage: odd.stage, message: odd.message }).toEqual({ stage: "load", message: "Its backend module's default export must be { register, migrations? }" });
  });

  test("without a backend file it has no backend part", async () => {
    const pkg = await openPackage(packageDir({ "dist/frontend.js": "" }, { backend: undefined }), "greeter");

    expect(await pkg.importBackend()).toBeNull();
  });

  test("its build ID covers every file it copies, a chunk too", async () => {
    const dir = packageDir({ "dist/server.js": "", "dist/frontend.js": "", "dist/chunks/a.js": "1" });
    const before = (await openPackage(dir, "greeter")).buildId;

    writeFileSync(join(dir, "dist/chunks/a.js"), "2");

    expect((await openPackage(dir, "greeter")).buildId).not.toBe(before);
  });

  test("installing copies only its built files and manifest, once for each build, and opens the copy", async () => {
    const dir = packageDir({ "dist/server.js": "export default { register: () => {} };", "dist/frontend.js": "", "dist/chunks/a.js": "", "src/frontend.ts": "", "node_modules/lit/index.js": "" });
    const builds = mkdtempSync(join(tmpdir(), "reins-builds-"));
    const pkg = await openPackage(dir, "greeter");

    const installed = await installPackage(pkg, builds);
    const again = await installPackage(pkg, builds);

    expect(installed.dir).toBe(join(builds, "greeter", pkg.buildId));
    expect({ id: installed.buildId, files: installed.files }).toEqual({ id: pkg.buildId, files: ["dist/chunks/a.js", "dist/frontend.js", "dist/server.js", "package.json"] });
    expect(existsSync(join(installed.dir, "src"))).toBe(false);
    expect(readdirSync(join(builds, "greeter"))).toEqual([pkg.buildId]);
    expect(again.dir).toBe(installed.dir);
    expect(await installed.importBackend()).not.toBeNull();
  });
});
