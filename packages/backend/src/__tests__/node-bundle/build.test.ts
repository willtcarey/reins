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

test("a production bundle leaves the faux-provider test hook out; a test-hooks bundle keeps it", async () => {
  const production = text((await buildNodeBundle()).bytes);
  const testHooks = text((await buildNodeBundle({ testHooks: true })).bytes);

  // The hook's environment variable, and the faux provider's own code (its scripted bash call).
  for (const hook of ["REINS_NODE_TEST_FAUX_PROVIDER", "echo ran >> tool-runs.log"]) {
    expect(production).not.toContain(hook);
    expect(testHooks).toContain(hook);
  }
});

test("a bundle has Pi's OAuth flows compiled in rather than behind a computed import", async () => {
  const bundle = text((await buildNodeBundle()).bytes);

  // Anthropic's OAuth flow module, which Pi otherwise loads only by a path the bundle cannot follow.
  expect(bundle).toContain("https://platform.claude.com/v1/oauth/token");
});

test("a bundle holding a path of the build machine, or importing what Bun does not provide, is not shippable", () => {
  expect(shippingProblems({ text: "export const here = \"/home/builder/reins/node_modules/x\";", externals: ["node:fs", "fs/promises", "bun:sqlite", "ws", "undici", "node-fetch", "left-pad"] }, ["/home/builder/reins", "/home/builder/"])).toEqual([
    "It contains the build machine's path /home/builder/reins",
    "It contains the build machine's path /home/builder/",
    "It imports left-pad, which Bun does not provide",
  ]);
  expect(shippingProblems({ text: "export {};", externals: ["path", "ws"] }, ["/home/builder/reins"])).toEqual([]);
});
