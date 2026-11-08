import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildVendor } from "../../vendor/build.js";

const FRONTEND = join(import.meta.dir, "../../..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The import map in index.html. */
function importMap(): Record<string, string> {
  const html = readFileSync(join(FRONTEND, "index.html"), "utf8");
  const json = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1];
  if (!json) throw new Error("index.html has no import map");
  return JSON.parse(json).imports;
}

/** What the browser resolves `specifier` to: an exact entry, else the longest prefix ending in "/". */
function resolve(map: Record<string, string>, specifier: string): string | null {
  if (map[specifier]) return map[specifier];
  const prefix = Object.keys(map).filter(key => key.endsWith("/") && specifier.startsWith(key)).toSorted((a, b) => b.length - a.length)[0];
  return prefix ? map[prefix] + specifier.slice(prefix.length) : null;
}

test("every public Lit module, resolved through index.html's import map, is a module the vendor build wrote", async () => {
  const out = mkdtempSync(join(tmpdir(), "reins-vendor-"));
  dirs.push(out);
  const lit = JSON.parse(readFileSync(join(dirname(Bun.resolveSync("lit/package.json", FRONTEND)), "package.json"), "utf8"));
  const specifiers = Object.keys(lit.exports).filter(key => key !== "./polyfill-support.js").map(key => key === "." ? "lit" : `lit/${key.slice(2)}`);

  await buildVendor(out);

  const map = importMap();
  const missing = specifiers.filter(specifier => {
    const url = resolve(map, specifier);
    return url === null || !url.startsWith("/dist/vendor/") || !existsSync(join(out, url.slice("/dist/vendor/".length)));
  });
  expect(missing).toEqual([]);
  expect(specifiers.length).toBeGreaterThan(30);
});
