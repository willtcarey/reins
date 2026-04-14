#!/usr/bin/env bun

import { ClaudeSdkAgentRuntime } from "../src/runtimes/claude_agent_sdk/runtime.js";

interface CliArgs {
  cwd: string;
  delayMs: number;
  prompt: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    cwd: process.cwd(),
    delayMs: 1200,
    prompt: "Compute 999*999. Think through carefully and return just the integer.",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cwd") {
      args.cwd = argv[i + 1] ?? args.cwd;
      i += 1;
      continue;
    }

    if (arg === "--delay-ms") {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed >= 0) {
        args.delayMs = parsed;
      }
      i += 1;
      continue;
    }

    if (arg === "--prompt") {
      args.prompt = argv[i + 1] ?? args.prompt;
      i += 1;
    }
  }

  return args;
}

function summarize(messages: any[]): string {
  return messages
    .map((message) => {
      const blockTypes = Array.isArray(message?.content)
        ? message.content.map((block: any) => block?.type).join("+")
        : "";
      return `${message?.role ?? "unknown"}:${blockTypes}`;
    })
    .join(" | ");
}

function extractAssistantText(messages: any[]): string {
  return messages
    .filter((message) => message?.role === "assistant")
    .flatMap((message) => Array.isArray(message?.content) ? message.content : [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n");
}

async function main() {
  const { cwd, delayMs, prompt } = parseArgs(Bun.argv.slice(2));
  const sessionId = crypto.randomUUID();

  console.log(`[claude-runtime-smoke] cwd=${cwd}`);
  console.log(`[claude-runtime-smoke] sessionId=${sessionId}`);

  const runtime = new ClaudeSdkAgentRuntime({
    sessionId,
    projectDir: cwd,
    systemPrompt: "You are a concise assistant.",
    resumeOnFirstPrompt: false,
    customTools: [],
  });

  try {
    await runtime.prompt(prompt);

    const immediate = await runtime.getMessages();
    await Bun.sleep(delayMs);
    const delayed = await runtime.getMessages();

    const immediateText = extractAssistantText(immediate as any[]);
    const delayedText = extractAssistantText(delayed as any[]);

    console.log(`[claude-runtime-smoke] immediate (${immediate.length}) ${summarize(immediate as any[])}`);
    console.log(`[claude-runtime-smoke] delayed (${delayed.length}) ${summarize(delayed as any[])}`);
    console.log(`[claude-runtime-smoke] immediate assistant text: ${JSON.stringify(immediateText)}`);
    console.log(`[claude-runtime-smoke] delayed assistant text: ${JSON.stringify(delayedText)}`);

    const reproduced = immediateText.length === 0 && delayedText.length > 0;
    console.log(`[claude-runtime-smoke] reproduced=${reproduced}`);
  } finally {
    await runtime.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`[claude-runtime-smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error("[claude-runtime-smoke] requires Claude Code auth and network access.");
  process.exitCode = 1;
}
