#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-agent-core";
import { ReinsResourceLoader } from "@reins/node/resources";
import { buildReinsSystemPrompt } from "@reins/node/system-prompt";
import { createReinsTools } from "@reins/node/reins-tools";

interface CliArgs {
  cwd: string;
  taskTitle?: string;
  taskDescription?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { cwd: process.cwd() };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cwd") {
      args.cwd = argv[++i] ?? args.cwd;
    } else if (arg === "--task-title") {
      args.taskTitle = argv[++i];
    } else if (arg === "--task-description") {
      args.taskDescription = argv[++i];
    }
  }

  return args;
}

async function main() {
  const { cwd, taskTitle, taskDescription } = parseArgs(Bun.argv.slice(2));
  const resources = new ReinsResourceLoader({ cwd: resolve(cwd) });
  resources.load();

  // Tool factories supply the same descriptions as production. No session,
  // database, model, or agent run is needed just to render the prompt.
  const unavailable = async (): Promise<never> => { throw new Error("Prompt rendering does not run tools"); };
  const tools = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool(),
    ...createReinsTools({ executeScript: unavailable, searchScript: unavailable, createTask: unavailable }),
  ];

  console.log(buildReinsSystemPrompt({
    tools,
    contextFiles: resources.contextFiles,
    skills: resources.skills,
    task: taskTitle ? { title: taskTitle, description: taskDescription ?? null } : undefined,
    isScratchSession: !taskTitle,
  }));
}

await main();
