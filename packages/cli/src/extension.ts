/**
 * `reins extension …`: Reins' extensions (docs/features/building-extensions.md). `add`, `list`, `reload`,
 * `remove`, `enable` and `disable` ask a Reins server (which one: server.ts), which loads an added extension's
 * built files from a directory on its own machine and turns any extension, built in or added, on or off.
 */
import type { ReinsClient } from "@reins/client";
import { resolve } from "node:path";
import { defineCommand, EXIT_FAILED, EXIT_OK } from "./command.js";
import { requestFailure, resolveServer, serverOptions } from "./server.js";

type ExtensionView = Awaited<ReturnType<ReinsClient["installedExtensions"]["list"]>>[number];

/** "Spoke (spoke) 0.2.0", or the name alone before its manifest was read. */
function describe(view: ExtensionView): string {
  return view.manifest ? `${view.manifest.label} (${view.name}) ${view.manifest.version}` : view.name;
}

/** What the command prints for the extension it added or reloaded: exit 0 when it loaded, 1 when it failed. */
function outcome(view: ExtensionView, done: string, { out, err }: { out(text: string): void; err(text: string): void }): number {
  if (view.status === "failed") {
    const source = view.source.kind === "path" ? ` from ${view.source.path}` : "";
    err(`${done} ${view.name}${source}, but it failed (${view.failure?.stage}): ${view.failure?.message}\nFix it, then run: reins extension reload ${view.name}`);
    return EXIT_FAILED;
  }
  const source = done === "Added" && view.source.kind === "path" ? ` from ${view.source.path}` : "";
  out(`${done} ${describe(view)}${source}: ${view.status}.`);
  return EXIT_OK;
}

export const extensionAddCommand = defineCommand({
  words: ["extension", "add"],
  args: ["path"],
  options: { ...serverOptions },
  summary: "Add the extension in a directory on the server's machine: Reins loads its built files",
  async run({ args: [path], options }, context) {
    const { serverUrl, client } = await resolveServer(options, context.env);
    let view;
    try {
      view = await client.installedExtensions.add(resolve(path));
    } catch (error) {
      const failure = requestFailure(error, serverUrl);
      context.err(`Not added: ${failure.message}`);
      return failure.exitCode;
    }
    return outcome(view, "Added", context);
  },
});

/** Why an extension failed, indented under its line, so the list says what to fix. */
function failureLines(view: ExtensionView): string[] {
  return [
    ...view.failure ? [`${view.failure.stage} failed: ${view.failure.message}`] : [],
    ...view.frontendFailure ? [`frontend failed in a browser at ${view.frontendFailure.at}: ${view.frontendFailure.message}`] : [],
  ].flatMap(text => text.split("\n")).map(line => `  ${line}`);
}

export const extensionListCommand = defineCommand({
  words: ["extension", "list"],
  args: [],
  options: { ...serverOptions },
  summary: "List the server's extensions, their status and where each came from",
  async run({ options }, { env, out, err }) {
    const { serverUrl, client } = await resolveServer(options, env);
    let views;
    try {
      views = await client.installedExtensions.list();
    } catch (error) {
      const failure = requestFailure(error, serverUrl);
      err(`No extensions listed: ${failure.message}`);
      return failure.exitCode;
    }
    out(views.length > 0
      ? views.flatMap(view => [`${view.name}\t${view.status}\t${view.source.kind === "path" ? view.source.path : "built in"}`, ...failureLines(view)]).join("\n")
      : "No extensions.");
    return EXIT_OK;
  },
});

export const extensionReloadCommand = defineCommand({
  words: ["extension", "reload"],
  args: ["name"],
  options: { ...serverOptions },
  summary: "Load an added extension's built files anew (its services restart, browsers load its frontend again)",
  async run({ args: [name], options }, context) {
    const { serverUrl, client } = await resolveServer(options, context.env);
    let view;
    try {
      view = await client.installedExtensions.reload(name);
    } catch (error) {
      const failure = requestFailure(error, serverUrl);
      context.err(`Not reloaded: ${failure.message}`);
      return failure.exitCode;
    }
    return outcome(view, "Reloaded", context);
  },
});

export const extensionRemoveCommand = defineCommand({
  words: ["extension", "remove"],
  args: ["name"],
  options: { ...serverOptions },
  summary: "Stop loading an added extension (its data and secrets stay on the server)",
  async run({ args: [name], options }, { env, out, err }) {
    const { serverUrl, client } = await resolveServer(options, env);
    try {
      await client.installedExtensions.remove(name);
    } catch (error) {
      const failure = requestFailure(error, serverUrl);
      err(`Not removed: ${failure.message}`);
      return failure.exitCode;
    }
    out(`Removed ${name}. Its data and secrets stay on the server; adding it again finds them.`);
    return EXIT_OK;
  },
});

/** `enable` or `disable`: the same request, with what it says. */
function switchCommand(enabled: boolean) {
  return defineCommand({
    words: ["extension", enabled ? "enable" : "disable"],
    args: ["name"],
    options: { ...serverOptions },
    summary: enabled
      ? "Turn an extension on again: it loads, and browsers load its frontend"
      : "Turn an extension off, built in or added: it stops and browsers drop it, until it is turned on",
    async run({ args: [name], options }, { env, out, err }) {
      const { serverUrl, client } = await resolveServer(options, env);
      try {
        await client.installedExtensions.setEnabled(name, enabled);
      } catch (error) {
        const failure = requestFailure(error, serverUrl);
        err(`Not turned ${enabled ? "on" : "off"}: ${failure.message}`);
        return failure.exitCode;
      }
      out(enabled ? `Turned on ${name}.` : `Turned off ${name}. Browsers drop it now; it stays off until you turn it on.`);
      return EXIT_OK;
    },
  });
}

export const extensionEnableCommand = switchCommand(true);
export const extensionDisableCommand = switchCommand(false);
