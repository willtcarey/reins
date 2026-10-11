/**
 * `reins node setup <server URL> <code>`: the node bundle's own install step, run by the install script
 * (`/nodes/install`) from the build it just downloaded. It installs that build (`NodeInstall.installBuild`:
 * current, and the launcher), pairs the home with the server unless it already is, starts the node in the
 * background (unless it already runs this build) and waits until it connects. Safe to run again with the
 * same arguments, the code already used: a home paired with this server is not paired again, unless the
 * server refuses its node (it was removed or revoked) and this run did not just use the code: then it pairs
 * again with the code given (as `reins node pair --force`) and starts the node again. See
 * docs/dev/node-contract.md *Pairing and authentication*.
 */
import { defineCommand, EXIT_FAILED } from "../command.js";
import { serverUrlArgument } from "../server.js";
import { NodeInstall, type Pairing } from "@reins/node/install";
import { EXIT_REFUSED, report, stepLine } from "./outcome.js";
import { EXIT_ALREADY_PAIRED, pairNode } from "./pair.js";

/** Exit 0 connected, 1 not run from a bundle, a node that exited or did not connect in time or an unexpected failure, 2 usage, 3 paired with another server, 4 the code or the
 * node refused, 5 the server unreachable; the last line says which. */
export const nodeSetupCommand = defineCommand({
  words: ["node", "setup"],
  args: ["server URL", "code"],
  options: {},
  summary: "Install this node bundle in the node home, pair it and start it (the install script runs it)",
  async run({ args: [serverUrl, code] }, context) {
    const { env, bundle, out, err } = context;
    const url = serverUrlArgument(serverUrl);
    if (!bundle) {
      err(`Not set up: reins node setup installs the node bundle it runs from, and this is not one. Install with: curl -fsSL ${url}/nodes/install | sh -s -- <code>; from source, use reins node pair and reins node run`);
      return EXIT_FAILED;
    }
    const install = NodeInstall.of(env);
    let pairing = await install.pairing();
    if (pairing && pairing.serverUrl !== url) {
      err(`Not set up: this machine's node is paired with ${pairing.serverUrl} (${install.paths.pairing}); the code was not used. To pair it with ${url} instead: ${install.command()} node pair --force ${url} <code>, then run the install command again`);
      return EXIT_ALREADY_PAIRED;
    }

    await install.installBuild(bundle);
    out(`Build ${bundle.buildId.slice(0, 12)} is current; run the node's commands with ${install.command()}`);

    /** Pairs the home with the code, replacing its pairing with `force`; the exit code when that failed (printed). */
    const pair = async (force: boolean): Promise<{ pairing: Pairing; name: string } | number> => {
      const paired = await pairNode({ install, serverUrl: url, code, force });
      switch (paired.status) {
        case "paired":
          out(`Paired with ${url} as node "${paired.name}" (${paired.pairing.nodeId}).`);
          return { pairing: paired.pairing, name: paired.name };
        case "already_paired":
          // Paired since this command read the pairing: by another command.
          err(`Not set up: this machine's node was paired while this ran (${install.paths.pairing}); run the install command again`);
          return EXIT_ALREADY_PAIRED;
        case "refused":
          err(`Not set up: the server refused the code: ${paired.message}`);
          return EXIT_REFUSED;
        case "request_failed":
          err(`Not set up: ${paired.message}`);
          return paired.exitCode;
      }
    };
    let name: string | undefined;
    // Whether this run used the code: then it cannot pair again with it.
    const pairedNow = !pairing;
    if (pairing) {
      out(`Already paired with ${url} as node ${pairing.nodeId}; the code was not used.`);
    } else {
      const paired = await pair(false);
      if (typeof paired === "number") return paired;
      ({ pairing, name } = paired);
    }

    const start = () => install.start(env, { replacingBuild: bundle.buildId, onStep: step => out(stepLine(step, install)) });
    let result = await start();
    if (result.outcome === "refused" && !result.code && !pairedNow) {
      // The server no longer serves this pairing (the node was removed or revoked there): the code given is
      // the user's way to pair this machine again. A refusal with a code (another Bun) is not the pairing's.
      out(`${url} refused node ${pairing.nodeId} (${result.message ?? "no reason given"}); pairing this machine again with the code given`);
      const paired = await pair(true);
      if (typeof paired === "number") return paired;
      ({ pairing, name } = paired);
      result = await start();
    }
    return report({ of: "start", result, pairing, ...(name ? { name } : {}) }, install, context);
  },
});
