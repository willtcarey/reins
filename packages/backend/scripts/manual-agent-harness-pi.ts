import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const requestedRoot = process.argv.includes("--root")
  ? process.argv[process.argv.indexOf("--root") + 1]
  : undefined;
const interactive = process.argv.includes("--interactive");
const root = requestedRoot ? resolve(requestedRoot) : await mkdtemp(join(tmpdir(), "reins-agent-harness-pi-"));
const dataDir = join(root, "data");
const projectDir = join(root, "project");
const homeDir = join(root, "home");
await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(projectDir, { recursive: true }), mkdir(homeDir, { recursive: true })]);

// Set every process-global location before importing Reins or Pi modules.
process.env.REINS_DATA_DIR = dataDir;
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
process.env.XDG_CONFIG_HOME = join(homeDir, ".config");
process.env.XDG_DATA_HOME = join(homeDir, ".local", "share");
process.env.XDG_CACHE_HOME = join(homeDir, ".cache");
process.env.PI_OFFLINE = "1";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const [{ fauxAssistantMessage, fauxProvider }, { createProject }, { createSession }, database, builder, factory] = await Promise.all([
  import("@earendil-works/pi-ai"),
  import("../src/project-store.js"),
  import("../src/session-store.js"),
  import("../src/db.js"),
  import("../src/runtimes/pi/agent-harness-builder.js"),
  import("../src/runtimes/pi/factory.js"),
]);

const provider = fauxProvider({ provider: "manual-faux", models: [{ id: "manual", contextWindow: 20_000, maxTokens: 1_000 }] });
factory.registerPiProvider(provider.provider);
const project = createProject("AgentHarness manual sandbox", projectDir);
createSession("manual-agent-harness", project.id, { agentRuntimeType: "pi" });
const state = { sessions: new Map(), clients: new Set(), frontendDir: join(root, "frontend") };

async function openRuntime() {
  return builder.buildAgentHarnessPiRuntime({
    state,
    projectId: project.id,
    projectDir,
    sessionId: "manual-agent-harness",
    task: null,
    model: { provider: "manual-faux", modelId: "manual" },
    thinkingLevel: "minimal",
    sessionTools: { builtins: ["read"], harnessTools: [] },
    resume: true,
  });
}

let runtime = await openRuntime();
provider.setResponses([fauxAssistantMessage("fake response one")]);
await runtime.prompt([{ type: "text", text: "first isolated fake prompt" }]);
await runtime.waitForIdle();
await runtime.close();
runtime = await openRuntime();
provider.setResponses([fauxAssistantMessage("fake response after reopen")]);
await runtime.prompt([{ type: "text", text: "continue after reopen" }]);
await runtime.waitForIdle();
console.log(`SANDBOX_ROOT=${root}`);
console.log(`DATABASE=${join(dataDir, "reins.db")}`);
console.log(`PROJECT=${projectDir}`);
console.log(`MESSAGES=${JSON.stringify(await runtime.getMessages())}`);
console.log("FAKE_REOPEN_OK");

if (interactive) {
  console.log("Commands: prompt <text>, messages, reopen, close, exit");
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  for await (const line of lines) {
    const [command, ...rest] = line.trim().split(" ");
    if (command === "prompt") {
      provider.setResponses([fauxAssistantMessage(`fake: ${rest.join(" ")}`)]);
      await runtime.prompt([{ type: "text", text: rest.join(" ") }]);
      await runtime.waitForIdle();
      console.log("PROMPT_OK");
    } else if (command === "messages") {
      console.log(JSON.stringify(await runtime.getMessages(), null, 2));
    } else if (command === "reopen") {
      await runtime.close();
      runtime = await openRuntime();
      console.log("REOPEN_OK");
    } else if (command === "close") {
      await runtime.close();
      console.log("CLOSE_OK");
    } else if (command === "exit") break;
    else console.log("Unknown command");
  }
  lines.close();
}

await runtime.close();
factory.unregisterPiProvider("manual-faux");
database.resetDb();
