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
  eventCount: number;
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

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    output: resolve(process.cwd(), "tmp/pi-manual-compaction-trace.json"),
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
  const workspace = await mkdtemp(resolve(tmpdir(), "reins-pi-manual-compaction-trace-"));
  const seedPrompt = "Reply with exactly: MANUAL_COMPACTION_SEED_READY";
  const customInstructions = "Preserve the seed completion exactly.";
  const compactionSettings = {
    enabled: false,
    reserveTokens: 16384,
    keepRecentTokens: 1,
  };
  const startedAt = performance.now();
  const events: EventObservation[] = [];
  const compactionStates: StateObservation[] = [];
  let messagesBefore: unknown[] = [];
  let messagesAfter: unknown[] = [];
  let entriesBefore: unknown[] = [];
  let entriesAfter: unknown[] = [];
  let compactionResult: unknown | null = null;
  let capturedError: unknown | null = null;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
  let modelIdentity = { provider: args.provider ?? "unresolved", id: args.model ?? "unresolved" };
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

    const sessionManager = SessionManager.inMemory();
    const created = await createAgentSession({
      cwd: workspace,
      tools: [],
      model,
      authStorage,
      modelRegistry,
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({ compaction: compactionSettings }),
    });
    session = created.session;
    const observe = (phase: string): StateObservation => ({
      phase,
      elapsedMs: elapsedMs(),
      eventCount: events.length,
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
      if (event.type === "compaction_end" && event.reason === "manual") {
        compactionStates.push(observe("compaction_end_callback_before_promise_settlement"));
      }
    });

    // Build persisted, compaction-eligible history through a real agent run. Auto
    // compaction is disabled so only the direct compact() call can compact it.
    await session.prompt(seedPrompt, { expandPromptTemplates: false });
    messagesBefore = snapshotForJson(session.messages);
    entriesBefore = snapshotForJson(sessionManager.getEntries());

    compactionStates.push(observe("before_compact_call"));
    const compactPromise = session.compact(customInstructions);
    compactionStates.push(observe("immediately_after_compact_call"));
    compactPromise.then(() => {
      compactionStates.push(observe("compaction_promise_fulfilled"));
    }, () => {
      compactionStates.push(observe("compaction_promise_rejected"));
    });
    compactionResult = snapshotForJson(await compactPromise);
    compactionStates.push(observe("after_compact_await"));

    messagesAfter = snapshotForJson(session.messages);
    entriesAfter = snapshotForJson(sessionManager.getEntries());
  } catch (error) {
    capturedError = snapshotForJson(error);
    if (session) messagesAfter = snapshotForJson(session.messages);
  } finally {
    session?.dispose();
    await rm(workspace, { recursive: true, force: true });
  }

  const manualStartIndex = events.findIndex(({ event }) => event["type"] === "compaction_start");
  const artifact = {
    version: 1,
    capturedAt: new Date().toISOString(),
    runtime: "pi",
    sdkPackage: `${packageMetadata.name}@${packageMetadata.version}`,
    workspace: "<fixture-workspace>",
    model: modelIdentity,
    invocation: {
      entrypoint: "AgentSession.compact(customInstructions?: string)",
      customInstructions,
      seedPrompt,
      compactionSettings,
    },
    compactionStates,
    events,
    messagesBefore,
    entriesBefore,
    compactionResult,
    messagesAfter,
    entriesAfter,
    error: capturedError,
    summary: {
      eventTypes: events.map(({ event }) => event["type"]),
      manualEventTypes: manualStartIndex < 0
        ? []
        : events.slice(manualStartIndex).map(({ event }) => event["type"]),
    },
  };
  await mkdir(dirname(args.output), { recursive: true });
  await Bun.write(args.output, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log(`[pi-manual-compaction-trace] output=${args.output}`);
  console.log(`[pi-manual-compaction-trace] model=${modelIdentity.provider}/${modelIdentity.id}`);
  console.log(`[pi-manual-compaction-trace] manual-types=${artifact.summary.manualEventTypes.join(" → ")}`);
  if (capturedError) {
    console.error("[pi-manual-compaction-trace] capture failed; error was written to the artifact");
    process.exitCode = 1;
  }
}

await main();
