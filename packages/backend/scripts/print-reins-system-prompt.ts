#!/usr/bin/env bun
/**
 * Prints an agent session's whole system prompt for a checkout, as its runtime prepares it at a run's first
 * request (`buildSessionRuntime`), without creating a session: the Reins prompt, then the environment of
 * every tool, merged from the server's `~/.agents` and the checkout's environment as a node on this machine
 * reports it (`checkout.environment`, from an in-process node).
 *
 *   bun packages/backend/scripts/print-reins-system-prompt.ts --cwd <checkout> [--task-title … --task-description …]
 */
import { resolve } from "node:path";
import { startNode } from "@reins/node/node";
import { reinsSystemPrompt } from "../src/sessions/system-prompt.js";
import { environmentPrompt } from "../src/session-runtime/environment.js";
import { mergeResources, serverAgentsDir, serverResources } from "../src/session-runtime/resources.js";
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
const node = startNode();
try {
  const checkout = await node.checkoutEnvironment({ sourceId: 1, cwd: resolve(cwd) });
  // The tools' own descriptions, as a session offers them; nothing runs them.
  const unavailable = async (): Promise<never> => { throw new Error("Prompt rendering does not run tools"); };
  const agentsDir = serverAgentsDir();
  const tools = [
    ...createHostTools({ sessionId: "prompt", sessionEnvironment: { provider: "none", modelId: "none" }, serverAgentsDir: agentsDir }),
    ...createReinsTools({ executeScript: unavailable, searchScript: unavailable, createTask: unavailable }),
  ];
  console.log(reinsSystemPrompt({ task: taskTitle ? { title: taskTitle, description: taskDescription ?? null } : null })
    + environmentPrompt({ tools, resources: mergeResources(serverResources(agentsDir), checkout) }));
} finally {
  await node.shutdown();
}
