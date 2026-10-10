/**
 * `reins node source add|remove|list`: the checkouts this machine's node serves, declared in its config
 * (`node.json`'s `sources`, config.ts). The node refuses every server call naming another checkout and
 * reports them to its server at each hello, where Settings → Nodes attaches them to projects. A running
 * node (`reins node run`) watches its config and reconnects to report a change. See
 * docs/dev/node-contract.md *Pairing and authentication*.
 */
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { nodeHome } from "@reins/node/node-home";
import { defineCommand, EXIT_FAILED, EXIT_OK, type Env } from "../command.js";
import { nodeConfigPath, readNodeConfig, writeNodeConfig, type NodeConfig } from "./config.js";

/** The home's config, or why there is none (the line to print). */
async function pairedConfig(env: Env, failure: string): Promise<{ home: string; config: NodeConfig } | { error: string }> {
  const home = nodeHome(env);
  const config = await readNodeConfig(home);
  if (!config) return { error: `${failure}: this machine's node is not paired (no ${nodeConfigPath(home)}). Pair it first: reins node pair <server URL> <code>` };
  return { home, config };
}

/** The directory at `path` as the filesystem names it, or null when there is no directory there. */
export async function directory(path: string): Promise<string | null> {
  try {
    const real = await realpath(path);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Declares `source` (a directory's real path, `directory`) in the paired home's config, once; `added`
 * is false when it already was. Resolves with the config as it now is. */
export async function addSource(home: string, config: NodeConfig, source: string): Promise<{ added: boolean; config: NodeConfig }> {
  if (config.sources.includes(source)) return { added: false, config };
  const added = { ...config, sources: [...config.sources, source] };
  await writeNodeConfig(home, added);
  return { added: true, config: added };
}

/** What `source add` prints for a source it declared, or that already was. */
export function sourceAdded(source: string, added: boolean): string {
  return added ? `Source added: ${source}` : `Already a source: ${source}`;
}

/** Exit 0 added (or already a source), 1 not a directory, not paired or an unexpected failure. */
export const nodeSourceAddCommand = defineCommand({
  words: ["node", "source", "add"],
  args: ["path"],
  options: {},
  summary: "Declare a checkout this machine's node serves (an existing directory)",
  async run({ args: [path] }, { env, out, err }) {
    const paired = await pairedConfig(env, "Not changed");
    if ("error" in paired) { err(paired.error); return EXIT_FAILED; }
    const source = await directory(resolve(path));
    if (!source) { err(`Not added: ${path} is not a directory`); return EXIT_FAILED; }
    const { added } = await addSource(paired.home, paired.config, source);
    out(sourceAdded(source, added));
    return EXIT_OK;
  },
});

/** Exit 0 removed, 1 not a source, not paired or an unexpected failure. */
export const nodeSourceRemoveCommand = defineCommand({
  words: ["node", "source", "remove"],
  args: ["path"],
  options: {},
  summary: "Stop serving a checkout: the node refuses work there from then on",
  async run({ args: [path] }, { env, out, err }) {
    const paired = await pairedConfig(env, "Not changed");
    if ("error" in paired) { err(paired.error); return EXIT_FAILED; }
    // A source whose directory is gone is named as it was declared.
    const named = resolve(path);
    const real = await directory(named);
    const source = paired.config.sources.find(declared => declared === named || declared === real);
    if (!source) { err(`Not removed: ${path} is not a source of this node`); return EXIT_FAILED; }
    await writeNodeConfig(paired.home, { ...paired.config, sources: paired.config.sources.filter(declared => declared !== source) });
    out(`Source removed: ${source}`);
    return EXIT_OK;
  },
});

/** Prints each source on its own line. Exit 0, 1 not paired or an unexpected failure. */
export const nodeSourceListCommand = defineCommand({
  words: ["node", "source", "list"],
  args: [],
  options: {},
  summary: "List the checkouts this machine's node serves",
  async run(_input, { env, out, err }) {
    const paired = await pairedConfig(env, "No sources");
    if ("error" in paired) { err(paired.error); return EXIT_FAILED; }
    const { sources } = paired.config;
    out(sources.length > 0 ? sources.join("\n") : "No sources declared. Add one: reins node source add <path>");
    return EXIT_OK;
  },
});
