import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildNodeBundle, shippingProblems } from "../../node-bundle/build.js";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("the build ID is the bundle's sha256, and the same sources build the same bytes, whatever the builder's NODE_ENV", async () => {
  const first = await buildNodeBundle();
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const second = await buildNodeBundle().finally(() => { process.env.NODE_ENV = nodeEnv; });

  expect(first.buildId).toBe(createHash("sha256").update(first.bytes).digest("hex"));
  expect(second.buildId).toBe(first.buildId);
});

test("a test build is another build of the same sources", async () => {
  const [production, testBuild] = await Promise.all([buildNodeBundle(), buildNodeBundle({ testBuild: true })]);

  expect(testBuild.buildId).not.toBe(production.buildId);
  expect(text(testBuild.bytes).startsWith(text(production.bytes).trimEnd())).toBe(true);
});

test("a bundle runs no Pi: of Pi it holds only the execution environment its tool host serves", async () => {
  const bundle = text((await buildNodeBundle()).bytes);

  expect(bundle).toContain("@earendil-works/pi-agent-core/dist/harness/env/nodejs.js");
  for (const absent of ["@earendil-works/pi-ai/", "@earendil-works/pi-coding-agent/", "@earendil-works/pi-agent-core/dist/harness/runtime/"]) expect(bundle).not.toContain(absent);
});

test("a bundle holding a path of the build machine, or importing what Bun does not provide, is not shippable", () => {
  expect(shippingProblems({ text: "export const here = \"/home/builder/reins/node_modules/x\";", externals: ["node:fs", "fs/promises", "bun:sqlite", "ws", "undici", "node-fetch", "left-pad"] }, ["/home/builder/reins", "/home/builder/"])).toEqual([
    "It contains the build machine's path /home/builder/reins",
    "It contains the build machine's path /home/builder/",
    "It imports left-pad, which Bun does not provide",
  ]);
  expect(shippingProblems({ text: "export {};", externals: ["path", "ws"] }, ["/home/builder/reins"])).toEqual([]);
});
