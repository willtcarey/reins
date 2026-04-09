#!/usr/bin/env bun

import { createAgentSession, createCodingTools, SessionManager } from "@mariozechner/pi-coding-agent";
import { createPiResourceLoader } from "../src/pi/resource-loader.js";
import { buildReinsSystemPrompt } from "../src/pi/system-prompt.js";
import { createCustomTools } from "../src/tools/index.js";

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
  const task = taskTitle
    ? { title: taskTitle, description: taskDescription ?? null }
    : null;

  const codingTools = createCodingTools(cwd);
  const customTools = createCustomTools({
    projectId: 0,
    sessionId: "prompt-debug",
    taskId: task ? 1 : null,
    broadcast: () => {},
    sessions: new Map(),
    createSession: async () => {
      throw new Error("createSession is not available in prompt debug script");
    },
    delegate: task
      ? {
          sessionId: "prompt-debug",
          deleteSession: () => {},
        }
      : undefined,
  });

  const allTools = [...codingTools, ...customTools];
  const resourceLoader = createPiResourceLoader({
    cwd,
    systemPromptOverride: () => buildReinsSystemPrompt({
      tools: allTools,
      task: task ?? undefined,
      isScratchSession: !task,
    }),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    tools: codingTools,
    customTools,
    sessionManager: SessionManager.inMemory(),
    resourceLoader,
  });

  console.log(session.systemPrompt);
}

await main();
