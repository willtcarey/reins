#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  query,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import {
  buildTraceArtifact,
  buildTracePrompt,
  serializeForJson,
  type TraceToolPlan,
} from "./lib/claude-sdk-trace-capture.js";

interface CliArgs {
  cwd: string;
  output: string;
  model: string;
  prompt: string | null;
  readPath: string;
  bashCommand: string;
}

function defaultOutputPath(): string {
  return resolve(process.cwd(), "tmp/claude-sdk-trace.json");
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    cwd: process.cwd(),
    output: defaultOutputPath(),
    model: "claude-sonnet-4-6",
    prompt: null,
    readPath: "package.json",
    bashCommand: "pwd",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--cwd" && next) {
      args.cwd = resolve(next);
      index += 1;
      continue;
    }

    if (arg === "--output" && next) {
      args.output = resolve(next);
      index += 1;
      continue;
    }

    if (arg === "--model" && next) {
      args.model = next;
      index += 1;
      continue;
    }

    if (arg === "--prompt" && next) {
      args.prompt = next;
      index += 1;
      continue;
    }

    if (arg === "--read-path" && next) {
      args.readPath = next;
      index += 1;
      continue;
    }

    if (arg === "--bash-command" && next) {
      args.bashCommand = next;
      index += 1;
    }
  }

  return args;
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const toolPlan: TraceToolPlan = {
    readPath: args.readPath,
    bashCommand: args.bashCommand,
  };
  const prompt = args.prompt ?? buildTracePrompt(toolPlan);
  const sessionId = crypto.randomUUID();

  const sdkMessages: unknown[] = [];
  let capturedError: unknown | null = null;
  let handle: Query | null = null;

  console.log(`[claude-sdk-trace] cwd=${args.cwd}`);
  console.log(`[claude-sdk-trace] model=${args.model}`);
  console.log(`[claude-sdk-trace] sessionId=${sessionId}`);
  console.log(`[claude-sdk-trace] output=${args.output}`);

  try {
    handle = query({
      prompt,
      options: {
        cwd: args.cwd,
        sessionId,
        model: args.model,
        tools: ["Read", "Bash"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        persistSession: true,
        settingSources: [],
        strictMcpConfig: true,
        systemPrompt: "You are capturing a reproducible Claude Code SDK trace. Follow the user's instructions exactly.",
      },
    });

    for await (const sdkMessage of handle) {
      sdkMessages.push(serializeForJson(sdkMessage));
    }
  } catch (error) {
    capturedError = serializeForJson(error);
  } finally {
    handle?.close?.();
  }

  const artifact = buildTraceArtifact({
    cwd: args.cwd,
    sessionId,
    model: args.model,
    prompt,
    toolPlan,
    sdkMessages,
    error: capturedError,
  });

  await writeJson(args.output, artifact);

  console.log(`[claude-sdk-trace] sdkMessages=${artifact.sdkMessages.length}`);
  console.log(`[claude-sdk-trace] toolCallIds=${artifact.summary.toolCallIds.join(",") || "(none)"}`);
  console.log(`[claude-sdk-trace] resultSubtype=${artifact.summary.resultSubtype ?? "(none)"}`);
  console.log(`[claude-sdk-trace] finalResultText=${JSON.stringify(artifact.summary.finalResultText)}`);

  if (capturedError) {
    console.error("[claude-sdk-trace] capture completed with error; see JSON artifact for details.");
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(`[claude-sdk-trace] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
