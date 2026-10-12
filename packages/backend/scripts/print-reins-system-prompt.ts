#!/usr/bin/env bun
/**
 * Prints an agent session's whole system prompt for a checkout, as its runtime prepares it at a run's first
 * request (`buildSessionRuntime`), without creating a session: the Reins prompt, then the environment of
 * every tool, merged from the server's `~/.agents` and the checkout's context files and skills, read here as
 * the local node would serve them (Pi's local environment), and this checkout's REINS docs.
 *
 *   bun packages/backend/scripts/print-reins-system-prompt.ts --cwd <checkout> [--task-title … --task-description …]
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { reinsSystemPrompt } from "../src/sessions/system-prompt.js";
import { environmentPrompt } from "../src/session-runtime/environment.js";
import { checkoutResources, mergeResources, serverAgentsDir, serverResources } from "../src/session-runtime/resources.js";
import { createHostTools } from "../src/session-runtime/tools.js";
import { createReinsTools } from "../src/session-runtime/reins-tools.js";

interface CliArgs {
  cwd: string;
  taskTitle?: string;
  taskDescription?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cwd") args.cwd = argv[++i] ?? args.cwd;
    else if (arg === "--task-title") args.taskTitle = argv[++i];
    else if (arg === "--task-description") args.taskDescription = argv[++i];
  }
  return args;
}

const { cwd, taskTitle, taskDescription } = parseArgs(Bun.argv.slice(2));
const checkout = await checkoutResources(new NodeExecutionEnv({ cwd: resolve(cwd) }), BACKGROUND_CONTEXT);
// The docs a local node running from this checkout announces.
const docsDir = join(import.meta.dir, "../../../docs");
// The tools' own descriptions, as a session offers them; nothing runs them.
const unavailable = async (): Promise<never> => { throw new Error("Prompt rendering does not run tools"); };
const agentsDir = serverAgentsDir();
const tools = [
  ...createHostTools({ sessionId: "prompt", sessionEnvironment: { provider: "none", modelId: "none" }, serverAgentsDir: agentsDir }),
  ...createReinsTools({ executeScript: unavailable, searchScript: unavailable, createTask: unavailable }),
];
console.log(reinsSystemPrompt({ task: taskTitle ? { title: taskTitle, description: taskDescription ?? null } : null })
  + environmentPrompt({ tools, resources: mergeResources(await serverResources(agentsDir), checkout, { dir: docsDir, devDocs: existsSync(join(docsDir, "dev")) }) }));
