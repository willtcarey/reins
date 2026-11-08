import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// The guide is how an extension is set up: an agent writes the files it shows. They are the example
// extension's, which Reins typechecks, tests and loads, so the guide cannot drift from what works.

const REPO = join(import.meta.dir, "../..");
const EXAMPLE = join(REPO, "examples/hello-extension");
const GUIDE = readFileSync(join(REPO, "docs/features/building-extensions.md"), "utf8");
/** The libraries an extension must have at the app's version: Lit (which the page provides), Tailwind (whose
 * output must match the app's classes) and TypeBox (whose schemas the host checks). */
const APP_LIBRARIES = ["lit", "tailwindcss", "@tailwindcss/cli", "@sinclair/typebox"];

/** Each file the guide shows, by its path in the example: the fenced block after `<!-- example: <path> -->`. */
function guideFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const match of GUIDE.matchAll(/<!-- example: (\S+) -->\n+```[a-z]*\n([\s\S]*?)```/g)) {
    files.set(match[1] ?? "", match[2] ?? "");
  }
  return files;
}

function exampleFiles(dir = EXAMPLE): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.name !== "node_modules" && entry.name !== "dist")
    .flatMap(entry => entry.isDirectory() ? exampleFiles(join(dir, entry.name)) : [relative(EXAMPLE, join(dir, entry.name))]);
}

/** The version of `name` installed for the app (the frontend's or the backend's). */
function appVersion(name: string): string {
  const file = ["packages/frontend", "packages/backend", "."]
    .map(dir => join(REPO, dir, "node_modules", name, "package.json")).find(path => existsSync(path));
  return file ? JSON.parse(readFileSync(file, "utf8")).version : "not installed";
}

describe("the extension guide", () => {
  test("shows every file of the example extension but its README, which is about the example", () => {
    expect([...guideFiles().keys()].toSorted()).toEqual(exampleFiles().filter(file => file !== "README.md").toSorted());
  });

  test("shows each file as the example has it; package.json with the SDK from a checkout, as an extension outside Reins has it", () => {
    for (const [path, text] of guideFiles()) {
      const actual = readFileSync(join(EXAMPLE, path), "utf8");
      if (path !== "package.json") {
        expect({ path, text }).toEqual({ path, text: actual });
        continue;
      }
      const shown = JSON.parse(text);
      const example = JSON.parse(actual);
      expect(shown.devDependencies["@reins/sdk"]).toBe("file:<Reins checkout>/packages/sdk");
      expect({ ...shown, name: example.name, devDependencies: { ...shown.devDependencies, "@reins/sdk": "workspace:*" } }).toEqual(example);
    }
  });

  test("the example uses the app's versions of the libraries it shares with it", () => {
    const { devDependencies } = JSON.parse(readFileSync(join(EXAMPLE, "package.json"), "utf8"));

    expect(Object.fromEntries(APP_LIBRARIES.map(name => [name, devDependencies[name]])))
      .toEqual(Object.fromEntries(APP_LIBRARIES.map(name => [name, appVersion(name)])));
  });
});
