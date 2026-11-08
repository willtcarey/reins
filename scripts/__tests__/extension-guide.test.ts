import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The guide tells an agent which versions of the libraries an extension shares with the app to use: they must
// be the app's.

const REPO = join(import.meta.dir, "../..");
const GUIDE = readFileSync(join(REPO, "docs/features/building-extensions.md"), "utf8");

/** The guide's version table: each row's packages (one or more, in backticks) and its version. */
function guideVersions(): Record<string, string> {
  const table = GUIDE.slice(GUIDE.indexOf("<!-- versions -->"), GUIDE.indexOf("<!-- /versions -->"));
  const versions: Record<string, string> = {};
  for (const [, packages = "", version = ""] of table.matchAll(/^\| ([^|]+) \| (\d[^|\s]*) \|/gm)) {
    for (const [, name = ""] of packages.matchAll(/`([^`]+)`/g)) versions[name] = version;
  }
  return versions;
}

/** The version of `name` installed for the app (the frontend's or the backend's). */
function appVersion(name: string): string {
  const file = ["packages/frontend", "packages/backend", "packages/sdk", "."]
    .map(dir => join(REPO, dir, "node_modules", name, "package.json")).find(path => existsSync(path));
  return file ? JSON.parse(readFileSync(file, "utf8")).version : "not installed";
}

describe("the extension guide", () => {
  test("gives the app's versions of the libraries an extension shares with it", () => {
    const versions = guideVersions();

    expect(Object.keys(versions).toSorted()).toEqual(["@sinclair/typebox", "@tailwindcss/cli", "lit", "tailwindcss"]);
    for (const [name, version] of Object.entries(versions)) {
      expect({ name, version }).toEqual({ name, version: appVersion(name) });
    }
  });
});
