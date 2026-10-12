import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context, type FauxResponseStep } from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { setApiKeyCredential } from "../../auth-credentials-store.js";
import { getDb } from "../../db.js";
import { loadMessages } from "../../messages-store.js";
import { runMigrations } from "../../migrations.js";
import { registerPiProvider, unregisterPiProvider } from "../../pi/factory.js";
import { suspendSessions } from "../../process-state.js";
import { getSession } from "../../session-store.js";
import { createTask } from "../../task-store.js";
import { createSession } from "../../sessions/create-session.js";
import { latestSettlement } from "../../sessions/session-runs.js";
import { closeSessionRuntime, openSessionRuntime } from "../../session-runtime/live.js";
import { ModelNotFoundError } from "../../session-runtime/pi-runtime.js";
import { createProject } from "../project-fixture.js";
import { closeSessions, createAppState, type TestAppState, type TestProcess } from "../helpers/app-state.js";
import { connectLoopbackNode, stopLoopbackNode } from "../helpers/loopback-node.js";
import { startApp, sessionEvents, sessionHost, until } from "../helpers/session-host.js";
import { git, useTestRepo } from "../helpers/test-repo.js";
import { useTestDb } from "../helpers/test-db.js";

setDefaultTimeout(20_000);
useTestDb();
const repo = useTestRepo();

const PIXEL = readFileSync(new URL("../fixtures/one-pixel.png", import.meta.url));
let home: string;
let previousHome: string | undefined;
let state: TestAppState;
let host: TestProcess & { frames: string[] };
let stopApp: () => void;
let provider: ReturnType<typeof fauxProvider>;
let providers = 0;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "reins-home-"));
  process.env.HOME = home;
  host = sessionHost();
  state = createAppState({ process: host });
  connectLoopbackNode(state);
  stopApp = startApp(state);
  // Registered with the server's model runtime only: no node knows this model.
  provider = fauxProvider({ provider: `server-only-${++providers}`, models: [{ id: "fake", input: ["text", "image"], contextWindow: 200_000, maxTokens: 1_000 }] });
  registerPiProvider(provider.provider);
  setApiKeyCredential(provider.provider.id, "test-key");
});

afterEach(async () => {
  await closeSessions(host);
  stopApp();
  await stopLoopbackNode(state);
  await state.nodes.close();
  unregisterPiProvider(provider.provider.id);
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

/** A session of the project on the test repo, on the faux model; `taskId` makes it a task session. */
function newSession(options: { taskId?: number; modelId?: string } = {}): string {
  const project = createProject("Runtime", repo.dir);
  return createSession(state, project.id, { model: { provider: provider.provider.id, modelId: options.modelId ?? "fake" }, ...(options.taskId === undefined ? {} : { taskId: options.taskId }) }).id;
}

/** Prompts the session's runtime on the server and waits for its run to settle on the session row. */
async function promptAndSettle(sessionId: string, text: string, responses: FauxResponseStep[]): Promise<void> {
  provider.setResponses(responses);
  const settled = latestSettlement(sessionId)?.seq ?? 0;
  const runtime = await openSessionRuntime(host, sessionId);
  await runtime.prompt([{ type: "text", text }], { reinsId: crypto.randomUUID() });
  await until(() => (latestSettlement(sessionId)?.seq ?? 0) > settled, "the run's settlement");
}

const toolUse = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args, { id: `${name}-call` }), { stopReason: "toolUse" });
const toolResults = (sessionId: string) => loadMessages(sessionId).filter(message => message.role === "toolResult");

describe("a session running on the server", () => {
  test("a prompt runs to settlement on a model only the server knows, its tool call runs on the node, and its events reach the browser clients", async () => {
    const sessionId = newSession();
    await promptAndSettle(sessionId, "Make a file", [
      toolUse("bash", { command: "echo hi > made.txt && echo \"made by $PI_MODEL\"" }),
      fauxAssistantMessage("Done"),
    ]);

    expect(readFileSync(join(repo.dir, "made.txt"), "utf8")).toBe("hi\n");
    expect(JSON.stringify(toolResults(sessionId))).toContain("made by fake");
    expect(latestSettlement(sessionId)).toMatchObject({ status: "completed" });
    expect(getSession(sessionId)).toMatchObject({ activity_state: "finished", model_provider: provider.provider.id, model_id: "fake" });
    const events = sessionEvents(host.frames, sessionId);
    expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.map(({ event }) => event.type)).toContain("tool_execution_end");
    expect(events.at(-1)?.event).toMatchObject({ type: "agent_end", status: "completed" });
  });

  test("a model the server's catalog does not have is refused when the runtime opens", async () => {
    const sessionId = newSession({ modelId: "missing" });
    await expect(openSessionRuntime(host, sessionId)).rejects.toBeInstanceOf(ModelNotFoundError);
  });

  test("the environment merges the server's ~/.agents with the checkout's, in the system prompt and in slash expansion, after checking out the task branch on the node", async () => {
    mkdirSync(join(home, ".agents/skills/server-skill"), { recursive: true });
    writeFileSync(join(home, ".agents/AGENTS.md"), "Server-wide instructions");
    writeFileSync(join(home, ".agents/skills/server-skill/SKILL.md"), "---\nname: server-skill\ndescription: The server's skill\n---\nServer skill body");
    mkdirSync(join(repo.dir, ".agents/skills/repo-skill"), { recursive: true });
    writeFileSync(join(repo.dir, "AGENTS.md"), "Checkout instructions");
    writeFileSync(join(repo.dir, ".agents/skills/repo-skill/SKILL.md"), "---\nname: repo-skill\ndescription: The checkout's skill\n---\nRepo skill body");
    await git(repo.dir, ["add", "."]);
    await git(repo.dir, ["commit", "-m", "Agents"]);
    await git(repo.dir, ["branch", "task/environment"]);
    const project = createProject("Environment", repo.dir);
    const task = createTask(project.id, "Environment", null, "task/environment");
    const sessionId = createSession(state, project.id, { model: { provider: provider.provider.id, modelId: "fake" }, taskId: task.id }).id;

    const seen: Context[] = [];
    await promptAndSettle(sessionId, "Use /repo-skill and /server-skill", [context => { seen.push(context); return fauxAssistantMessage("ok"); }]);

    expect(await git(repo.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("task/environment");
    const systemPrompt = seen[0]!.systemPrompt!;
    expect(systemPrompt.indexOf("Server-wide instructions")).toBeGreaterThan(-1);
    expect(systemPrompt.indexOf("Checkout instructions")).toBeGreaterThan(systemPrompt.indexOf("Server-wide instructions"));
    expect(systemPrompt).toContain(`<location>${join(home, ".agents/skills/server-skill/SKILL.md")}</location>`);
    expect(systemPrompt).toContain(`<location>${join(repo.dir, ".agents/skills/repo-skill/SKILL.md")}</location>`);
    expect(systemPrompt).toContain("- bash: Execute bash commands");
    expect(systemPrompt).toContain("Feature docs: ");
    const prompt = JSON.stringify(seen[0]!.messages[0]);
    expect(prompt).toContain("Repo skill body");
    expect(prompt).toContain("Server skill body");
  });

  test("a tool-result image is stored as the session's attachment before it is committed, and the provider gets its bytes", async () => {
    writeFileSync(join(repo.dir, "pixel.png"), PIXEL);
    const sessionId = newSession();
    const provided: string[] = [];
    await promptAndSettle(sessionId, "Look", [
      toolUse("read", { path: "pixel.png" }),
      context => {
        for (const message of context.messages) {
          if (message.role !== "toolResult") continue;
          for (const block of message.content) if (block.type === "image") provided.push(block.data);
        }
        return fauxAssistantMessage("Seen");
      },
    ]);

    const sha256 = createHash("sha256").update(PIXEL).digest("hex");
    const stored = getDb().query<{ id: string; sha256: string }, [string]>("SELECT id, sha256 FROM session_attachments WHERE session_id = ?").all(sessionId);
    expect(stored).toEqual([{ id: expect.stringMatching(/^att_/), sha256 }]);
    const image = toolResults(sessionId)[0].content.find((block: { type: string }) => block.type === "image");
    expect(image).toEqual({ type: "image", attachmentId: stored[0]!.id, mimeType: "image/png", byteSize: PIXEL.byteLength, sha256 });
    expect(provided).toEqual([PIXEL.toString("base64")]);
    expect(host.frames.some(frame => frame.includes(PIXEL.toString("base64")))).toBe(false);
  });

  test("a bash command running when its runtime is suspended (the server's SIGTERM) goes on on the node: the runtime that resumes the run picks it up again and gets its result, and it ran once", async () => {
    const sessionId = newSession();
    provider.setResponses([
      toolUse("bash", { command: "echo start >> runs.log; echo started; while [ ! -e release ]; do sleep 0.01; done; echo done" }),
      fauxAssistantMessage("Done"),
    ]);
    const runtime = await openSessionRuntime(host, sessionId);
    await runtime.prompt([{ type: "text", text: "Run it" }], { reinsId: "suspended" });
    await until(() => existsSync(join(repo.dir, "runs.log")), "the command started");
    await suspendSessions(host.sessions, { pauseMs: 50 });
    host.sessions.pauseGate.open();

    const resumed = await openSessionRuntime(host, sessionId);
    expect(await resumed.resumePendingOperation()).toBe(true);
    await Bun.sleep(100);
    writeFileSync(join(repo.dir, "release"), "");
    await until(() => latestSettlement(sessionId)?.status === "completed", "the resumed run completed");
    expect(readFileSync(join(repo.dir, "runs.log"), "utf8")).toBe("start\n");
    expect(toolResults(sessionId)).toMatchObject([{ isError: false, content: [{ type: "text", text: "started\ndone\n" }] }]);
  });

  test("a run whose checkout cannot be prepared fails, without asking the model", async () => {
    const project = createProject("Missing branch", repo.dir);
    const task = createTask(project.id, "Missing", null, "task/missing");
    const sessionId = createSession(state, project.id, { model: { provider: provider.provider.id, modelId: "fake" }, taskId: task.id }).id;
    const runtime = await openSessionRuntime(host, sessionId);
    await runtime.prompt([{ type: "text", text: "Hello" }], { reinsId: "missing" });
    await until(() => latestSettlement(sessionId) !== null, "the run settled");
    expect(latestSettlement(sessionId)).toMatchObject({ status: "failed", error: { message: expect.stringContaining("Preparing the checkout failed") } });
    expect(provider.state.callCount).toBe(0);
  });
});

describe("a session whose stored assistant messages predate usage", () => {
  test("fails to take a prompt until migration 053 gives them a zero usage", async () => {
    const sessionId = newSession();
    // Stamped when it is answered, after the prompt, as a real provider's message is.
    await promptAndSettle(sessionId, "Hello", [() => fauxAssistantMessage("Hi", { timestamp: Date.now() })]);
    await closeSessionRuntime(host, sessionId);
    // As older sessions were stored: the assistant message has no usage, and 053 has not run.
    getDb().exec(`UPDATE session_messages SET message_json = json_remove(message_json, '$.message.usage') WHERE role = 'assistant';
      DELETE FROM migrations WHERE name = '053_zero_usage_on_legacy_assistant_messages';`);
    // Every real provider builds its request options this way, estimating the context's tokens from its
    // last assistant usage.
    const asAProvider = (text: string): FauxResponseStep => (context, options, _state, model) => {
      buildBaseOptions(model, context, options);
      return fauxAssistantMessage(text);
    };

    await promptAndSettle(sessionId, "Again", [asAProvider("Unreached")]);
    expect(latestSettlement(sessionId)).toMatchObject({ status: "failed", error: { message: expect.stringContaining("usage.totalTokens") } });
    await closeSessionRuntime(host, sessionId);

    runMigrations(getDb());
    await promptAndSettle(sessionId, "Once more", [asAProvider("Reached")]);
    expect(latestSettlement(sessionId)).toMatchObject({ status: "completed" });
    expect(loadMessages(sessionId).at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Reached" }] });
  });
});

describe("a run whose node is offline at its first request", () => {
  test("waits there, held at a pause point, and proceeds once the node connects", async () => {
    const sessionId = newSession();
    await stopLoopbackNode(state);
    provider.setResponses([fauxAssistantMessage("Reached")]);
    const runtime = await openSessionRuntime(host, sessionId);
    await runtime.prompt([{ type: "text", text: "Hello" }], { reinsId: "offline" });
    await until(() => getSession(sessionId)?.activity_state === "running", "the run started");
    await Bun.sleep(100);
    expect(provider.state.callCount).toBe(0);
    expect(runtime.isPaused()).toBe(true);

    connectLoopbackNode(state);
    await until(() => latestSettlement(sessionId)?.status === "completed", "the run completed");
    expect(provider.state.callCount).toBe(1);
  });

  test("can be aborted while it waits", async () => {
    const sessionId = newSession();
    await stopLoopbackNode(state);
    const runtime = await openSessionRuntime(host, sessionId);
    await runtime.prompt([{ type: "text", text: "Hello" }], { reinsId: "aborted" });
    await until(() => getSession(sessionId)?.activity_state === "running", "the run started");
    await runtime.abort();
    await until(() => latestSettlement(sessionId) !== null, "the run settled");
    expect(latestSettlement(sessionId)).toMatchObject({ status: "aborted" });
    expect(provider.state.callCount).toBe(0);
  });
});
