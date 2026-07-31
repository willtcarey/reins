#!/usr/bin/env bun

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import packageMetadata from "@earendil-works/pi-coding-agent/package.json";
import { resolveModelSettingWithConfigInRegistry } from "../src/models/model-settings.js";
import { createPiContext } from "../src/runtimes/pi/factory.js";
import { snapshotForJson } from "./lib/pi-runtime-trace-capture.js";

interface CliArgs {
  output: string;
  provider: string | null;
  model: string | null;
}

interface StateObservation {
  phase: string;
  elapsedMs: number;
  isStreaming: boolean;
  isCompacting: boolean;
}

interface EventObservation extends StateObservation {
  sequence: number;
  event: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function eventRole(event: Record<string, unknown>): unknown {
  const message = event["message"];
  return isRecord(message) ? message["role"] : null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    output: resolve(process.cwd(), "tmp/pi-compaction-trace.json"),
    provider: null,
    model: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--output" && next) args.output = resolve(next);
    else if (arg === "--provider" && next) args.provider = next;
    else if (arg === "--model" && next) args.model = next;
    else continue;
    index += 1;
  }
  if ((args.provider === null) !== (args.model === null)) {
    throw new Error("--provider and --model must be supplied together");
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const workspace = await mkdtemp(resolve(tmpdir(), "reins-pi-compaction-trace-"));
  const prompt = "Reply with exactly: COMPACTION_TRACE_READY";
  const startedAt = performance.now();
  const events: EventObservation[] = [];
  const promptStates: StateObservation[] = [];
  let finalMessages: unknown[] = [];
  let capturedError: unknown | null = null;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
  let modelIdentity = { provider: args.provider ?? "unresolved", id: args.model ?? "unresolved" };
  let compactionSettings = { enabled: true, reserveTokens: 0, keepRecentTokens: 1 };
  const elapsedMs = () => Math.round(performance.now() - startedAt);

  try {
    const { authStorage, modelRegistry, resourceLoader } = await createPiContext({
      cwd: workspace,
      resourceLoaderOptions: {
        systemPrompt: "Answer the user's request exactly and concisely.",
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    });
    const requestedModel = args.provider && args.model
      ? modelRegistry.find(args.provider, args.model)
      : undefined;
    if (args.provider && args.model && !requestedModel) {
      throw new Error(`Pi model not found: ${args.provider}/${args.model}`);
    }
    const model = requestedModel
      ?? resolveModelSettingWithConfigInRegistry("utility_model", modelRegistry)?.model
      ?? resolveModelSettingWithConfigInRegistry("default_model", modelRegistry)?.model
      ?? modelRegistry.getAvailable()[0];
    if (!model) {
      throw new Error("No authenticated Pi model is available; configure credentials and a default model in Reins");
    }
    modelIdentity = { provider: model.provider, id: model.id };

    // Pi 0.80.6 triggers threshold compaction when usage is greater than
    // contextWindow - reserveTokens. Setting reserveTokens to the full model
    // context window makes any successful non-empty response cross the threshold.
    compactionSettings = {
      enabled: true,
      reserveTokens: model.contextWindow,
      keepRecentTokens: 1,
    };
    const created = await createAgentSession({
      cwd: workspace,
      tools: [],
      model,
      authStorage,
      modelRegistry,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: compactionSettings }),
    });
    session = created.session;
    const observe = (phase: string): StateObservation => ({
      phase,
      elapsedMs: elapsedMs(),
      isStreaming: session!.isStreaming,
      isCompacting: session!.isCompacting,
    });
    session.subscribe((event) => {
      const snapshot = snapshotForJson(event);
      events.push({
        ...observe("event_callback"),
        sequence: events.length,
        event: isRecord(snapshot) ? snapshot : { type: "unknown" },
      });
    });

    promptStates.push(observe("before_prompt_call"));
    const promptPromise = session.prompt(prompt, { expandPromptTemplates: false });
    promptStates.push(observe("immediately_after_prompt_call"));
    await promptPromise;
    promptStates.push(observe("after_prompt_settlement"));
    finalMessages = snapshotForJson(session.messages);
  } catch (error) {
    capturedError = snapshotForJson(error);
    if (session) finalMessages = snapshotForJson(session.messages);
  } finally {
    session?.dispose();
    await rm(workspace, { recursive: true, force: true });
  }

  const artifact = {
    version: 1,
    capturedAt: new Date().toISOString(),
    runtime: "pi",
    sdkPackage: `${packageMetadata.name}@${packageMetadata.version}`,
    workspace: "<fixture-workspace>",
    model: modelIdentity,
    trigger: {
      kind: "threshold-after-agent-end",
      prompt,
      compactionSettings,
      thresholdExpression: "contextTokens > contextWindow - reserveTokens",
    },
    promptStates,
    events,
    finalMessages,
    error: capturedError,
    summary: {
      eventTypes: events.map(({ event }) => event["type"]),
      lifecycle: events
        .filter(({ event }) => [
          "agent_start",
          "agent_end",
          "agent_settled",
          "turn_start",
          "turn_end",
          "message_start",
          "message_end",
          "compaction_start",
          "compaction_end",
        ].includes(String(event["type"])))
        .map(({ sequence, elapsedMs: elapsed, isStreaming, isCompacting, event }) => ({
          sequence,
          elapsedMs: elapsed,
          type: event["type"],
          role: eventRole(event),
          reason: event["reason"] ?? null,
          willRetry: event["willRetry"] ?? null,
          isStreaming,
          isCompacting,
        })),
    },
  };
  await mkdir(dirname(args.output), { recursive: true });
  await Bun.write(args.output, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log(`[pi-compaction-trace] output=${args.output}`);
  console.log(`[pi-compaction-trace] model=${modelIdentity.provider}/${modelIdentity.id}`);
  console.log(`[pi-compaction-trace] types=${artifact.summary.eventTypes.join(" → ")}`);
  if (capturedError) {
    console.error("[pi-compaction-trace] capture failed; error was written to the artifact");
    process.exitCode = 1;
  }
}

await main();
