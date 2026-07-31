#!/usr/bin/env bun

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import packageMetadata from "@earendil-works/pi-coding-agent/package.json";
import { resolveModelSettingWithConfigInRegistry } from "../src/models/model-settings.js";
import { createPiContext } from "../src/runtimes/pi/factory.js";
import {
  buildPiTraceArtifact,
  buildPiTracePrompt,
  snapshotForJson,
  type PiTraceToolPlan,
} from "./lib/pi-runtime-trace-capture.js";

interface CliArgs {
  output: string;
  provider: string | null;
  model: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    output: resolve(process.cwd(), "tmp/pi-runtime-trace.json"),
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
  const workspace = await mkdtemp(resolve(tmpdir(), "reins-pi-trace-"));
  const readPath = "trace-input.txt";
  const toolPlan: PiTraceToolPlan = {
    readPath,
    bashCommand: "printf 'PI_BASH_TRACE_OK\\n'",
  };
  const prompt = buildPiTracePrompt(toolPlan);
  const replacements = new Map<string, string>([
    [workspace, "<fixture-workspace>"],
    [homedir(), "<home>"],
  ]);
  const events: unknown[] = [];
  let finalMessages: unknown[] = [];
  let capturedError: unknown | null = null;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
  let modelIdentity = { provider: args.provider ?? "unresolved", id: args.model ?? "unresolved" };

  try {
    await writeFile(resolve(workspace, readPath), "PI_READ_TRACE_OK\n", "utf8");
    const { authStorage, modelRegistry, resourceLoader } = await createPiContext({
      cwd: workspace,
      resourceLoaderOptions: {
        systemPrompt: "You are capturing a reproducible Pi runtime event trace. Follow the user instructions exactly.",
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

    const created = await createAgentSession({
      cwd: workspace,
      tools: ["read", "bash"],
      model,
      authStorage,
      modelRegistry,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
    });
    session = created.session;
    session.subscribe((event) => {
      events.push(snapshotForJson(event, replacements));
    });
    await session.prompt(prompt, { expandPromptTemplates: false });
    finalMessages = snapshotForJson(session.messages, replacements);
  } catch (error) {
    capturedError = snapshotForJson(error, replacements);
    if (session) finalMessages = snapshotForJson(session.messages, replacements);
  } finally {
    session?.dispose();
    await rm(workspace, { recursive: true, force: true });
  }

  const artifact = buildPiTraceArtifact({
    sdkPackage: `${packageMetadata.name}@${packageMetadata.version}`,
    model: modelIdentity,
    prompt,
    toolPlan,
    events,
    finalMessages,
    error: capturedError,
  });
  await mkdir(dirname(args.output), { recursive: true });
  await Bun.write(args.output, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log(`[pi-runtime-trace] output=${args.output}`);
  console.log(`[pi-runtime-trace] model=${modelIdentity.provider}/${modelIdentity.id}`);
  console.log(`[pi-runtime-trace] events=${events.length}`);
  console.log(`[pi-runtime-trace] types=${artifact.summary.eventTypes.join(" → ")}`);
  if (capturedError) {
    console.error("[pi-runtime-trace] capture failed; error was written to the artifact");
    process.exitCode = 1;
  }
}

await main();
