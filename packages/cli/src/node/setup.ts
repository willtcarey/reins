/**
 * `reins node setup <server URL> <code> [--source <path>]...`: the node bundle's own install step, run by
 * the install script (`/nodes/install`) from the build it just downloaded. It makes that build current
 * and writes the launcher (install.ts), pairs the home with the server unless it already is, declares the
 * sources, starts the node in the background (unless it already runs this build) and waits until it
 * connects. Safe to run again with the same arguments, the code already used: a home paired with this
 * server is not paired again. See docs/dev/node-contract.md *Pairing and authentication*.
 */
import { resolve } from "node:path";
import { nodeHome } from "@reins/node/node-home";
import { defineCommand, EXIT_FAILED } from "../command.js";
import { serverUrlArgument } from "../server.js";
import { nodeConfigPath, readNodeConfig } from "./config.js";
import { reinsCommand, startInstalledNode } from "./control.js";
import { activateBuild, writeLauncher } from "./install.js";
import { EXIT_ALREADY_PAIRED, EXIT_CODE_REFUSED, pairNode } from "./pair.js";
import { addSource, directory, sourceAdded } from "./source.js";

/** Exit 0 connected, 1 not run from a bundle, a source that is not a directory, a node that exited or did
 * not connect in time or an unexpected failure, 2 usage, 3 paired with another server, 4 the code or the
 * node refused, 5 the server unreachable; the last line says which. */
export const nodeSetupCommand = defineCommand({
  words: ["node", "setup"],
  args: ["server URL", "code"],
  options: { source: { type: "string", value: "path", multiple: true, description: "Declare a checkout the node serves (repeatable)" } },
  summary: "Install this node bundle in the node home, pair it, declare its sources and start it (the install script runs it)",
  async run({ args: [serverUrl, code], options }, context) {
    const { env, bundle, out, err } = context;
    const url = serverUrlArgument(serverUrl);
    if (!bundle) {
      err(`Not set up: reins node setup installs the node bundle it runs from, and this is not one. Install with: curl -fsSL ${url}/nodes/install | sh -s -- <code>; from source, use reins node pair and reins node run`);
      return EXIT_FAILED;
    }
    const home = nodeHome(env);
    // Checked before anything changes, so a mistake costs neither the code nor the running node.
    const sources: string[] = [];
    for (const path of options.source) {
      const source = await directory(resolve(path));
      if (!source) { err(`Not set up: ${path} is not a directory`); return EXIT_FAILED; }
      sources.push(source);
    }
    let config = await readNodeConfig(home);
    if (config && config.serverUrl !== url) {
      err(`Not set up: this machine's node is paired with ${config.serverUrl} (${nodeConfigPath(home)}); the code was not used. To pair it with ${url} instead: ${reinsCommand(home)} node pair --force ${url} <code>, then run the install command again`);
      return EXIT_ALREADY_PAIRED;
    }

    const buildId = await activateBuild(home, bundle);
    await writeLauncher(home);
    out(`Build ${buildId.slice(0, 12)} is current; run the node's commands with ${reinsCommand(home)}`);

    let name: string | undefined;
    if (config) {
      out(`Already paired with ${url} as node ${config.nodeId}; the code was not used.`);
    } else {
      const paired = await pairNode({ home, serverUrl: url, code });
      switch (paired.status) {
        case "paired":
          ({ config, name } = paired);
          out(`Paired with ${url} as node "${paired.name}" (${paired.config.nodeId}).`);
          break;
        case "already_paired":
          // Paired since this command read the config: by another command.
          err(`Not set up: this machine's node was paired while this ran (${paired.configPath}); run the install command again`);
          return EXIT_ALREADY_PAIRED;
        case "refused":
          err(`Not set up: the server refused the code: ${paired.message}`);
          return EXIT_CODE_REFUSED;
        case "request_failed":
          err(`Not set up: ${paired.message}`);
          return paired.exitCode;
      }
    }
    for (const source of sources) {
      const added = await addSource(home, config, source);
      config = added.config;
      out(sourceAdded(source, added.added));
    }

    return startInstalledNode(home, config, context, { buildId, ...(name ? { name } : {}) });
  },
});
