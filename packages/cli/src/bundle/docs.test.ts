import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackDocs } from "./docs.js";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function buildDir() {
  const dir = mkdtempSync(join(tmpdir(), "reins-bundle-docs-"));
  temps.push(dir);
  return dir;
}

const docs = [{ path: "features/settings.md", text: "# Settings\n" }, { path: "features/tasks.md", text: "# Tasks\n" }];

test("writes the docs under <dir>/docs, leaving nothing else beside them", async () => {
  const dir = buildDir();
  writeFileSync(join(dir, "reins.js"), "");

  await unpackDocs(dir, docs);

  expect(readdirSync(dir).toSorted()).toEqual(["docs", "reins.js"]);
  expect(readdirSync(join(dir, "docs/features")).toSorted()).toEqual(["settings.md", "tasks.md"]);
  expect(readFileSync(join(dir, "docs/features/settings.md"), "utf8")).toBe("# Settings\n");
});

test("leaves docs already there as they are", async () => {
  const dir = buildDir();
  mkdirSync(join(dir, "docs/features"), { recursive: true });
  writeFileSync(join(dir, "docs/features/settings.md"), "edited\n");

  await unpackDocs(dir, docs);

  expect(readdirSync(dir)).toEqual(["docs"]);
  expect(readdirSync(join(dir, "docs/features"))).toEqual(["settings.md"]);
  expect(readFileSync(join(dir, "docs/features/settings.md"), "utf8")).toBe("edited\n");
});

test("of runs racing to unpack, one writes the docs and none fails", async () => {
  const dir = buildDir();

  await Promise.all(Array.from({ length: 5 }, () => unpackDocs(dir, docs)));

  expect(readdirSync(dir)).toEqual(["docs"]);
  expect(readdirSync(join(dir, "docs/features")).toSorted()).toEqual(["settings.md", "tasks.md"]);
});
