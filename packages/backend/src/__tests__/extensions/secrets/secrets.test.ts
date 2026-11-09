import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useTestDb } from "../../helpers/test-db.js";
import { createAppState, type TestAppState } from "../../helpers/app-state.js";
import { loopbackLink, stopLoopbackNode } from "../../helpers/loopback-node.js";
import { useFakeModel } from "../../helpers/fake-model.js";
import { makeRequest } from "../../helpers/request.js";
import { scriptContext } from "../../helpers/script-context.js";
import { runScript } from "../../../tools/execute.js";
import { buildRouter } from "../../../routes/index.js";
import { Models } from "../../../models/models.js";
import { getDb } from "../../../app-globals.js";
import { secrets, startSecrets } from "../../../extensions/secrets/index.js";
import type { Secrets } from "../../../extensions/secrets/secrets.js";

const router = buildRouter();
const VALUE = "sk-live-'quoted' $value";

/** What the session's messages hold, every row as stored. */
const transcript = (sessionId: string) => getDb().query<{ message_json: string }, [string]>("SELECT message_json FROM session_messages WHERE session_id = ? ORDER BY seq").all(sessionId).map(row => row.message_json).join("\n");

describe("the secrets extension", () => {
  useTestDb();
  const model = useFakeModel();
  let state: TestAppState;
  let dir: string;
  let now: Date;
  let extension: Secrets | undefined;

  /** Runs `code` as an `execute` script of session `sessionId`; its result, or its error's message. */
  const script = async (sessionId: string, code: string) => {
    const result = await runScript(scriptContext(state, { sessionId }), code);
    if (!result.ok) return { error: result.error };
    try { return JSON.parse(result.text || "null"); } catch { return result.text; }
  };
  const call = async (method: string, input?: unknown) => {
    const response = (await router.handle(makeRequest("POST", `/api/extensions/secrets/${method}`, input), state))!;
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  const newSession = async () => (await new Models(state).sessions.create({ source: { nodeId: "internal", path: dir }, model: model.model })).id;
  const REQUEST = `return await reins.secrets.request({ names: ["OPENAI_API_KEY", "RESEND_API_KEY"], purpose: "Configure the server", descriptions: { OPENAI_API_KEY: "OpenAI key" } })`;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "reins-secrets-"));
    now = new Date("2026-04-01T10:00:00.000Z");
    state = createAppState(undefined, {
      loopbackNode: true,
      extensions: [{
        name: "secrets",
        migrations: secrets.migrations,
        register: reins => {
          const started = startSecrets(reins, { now: () => now, sweepMs: 3_600_000 });
          extension = started.extension;
          return started.dispose;
        },
      }],
    });
    await loopbackLink(state).ready();
  });
  afterEach(async () => {
    await stopLoopbackNode(state);
    await state.nodes.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a request returns at once, telling the agent to end its turn, and its session's form can read it", async () => {
    const sessionId = await newSession();

    const answer = await script(sessionId, REQUEST);
    const { body: open } = await call("requests");

    expect(answer).toEqual({ requested: ["OPENAI_API_KEY", "RESEND_API_KEY"], next: expect.stringContaining("End your turn") });
    expect(open).toEqual([{
      id: expect.any(String), sessionId, purpose: "Configure the server", createdAt: "2026-04-01T10:00:00.000Z",
      fields: [{ name: "OPENAI_API_KEY", description: "OpenAI key" }, { name: "RESEND_API_KEY", description: null }],
    }]);
  });

  test("refuses names that are not variable names, repeated or missing, and descriptions of names not asked for", async () => {
    const sessionId = await newSession();

    expect(await script(sessionId, `return await reins.secrets.request({ names: ["1KEY"] })`)).toEqual({ error: expect.stringContaining("start with a letter or underscore") });
    expect(await script(sessionId, `return await reins.secrets.request({ names: ["KEY", "KEY"] })`)).toEqual({ error: expect.stringContaining("unique") });
    expect(await script(sessionId, `return await reins.secrets.request({ names: [] })`)).toEqual({ error: expect.stringContaining("names") });
    expect(await script(sessionId, `return await reins.secrets.request({ names: ["KEY"], descriptions: { OTHER: "x" } })`)).toEqual({ error: expect.stringContaining("OTHER") });
    expect((await call("requests")).body).toEqual([]);
  });

  test("a submitted form stores the values and wakes the session with a handle for each name, which a script gives a command as its env", async () => {
    const sessionId = await newSession();
    await script(sessionId, REQUEST);
    const [request] = (await call("requests")).body;

    const submitted = await call("submit", { id: request.id, values: { OPENAI_API_KEY: VALUE, RESEND_API_KEY: "re_123" } });
    const turn = await model.nextTurn(sessionId);
    const handle = /OPENAI_API_KEY: (sec_[\w-]+)/.exec(turn.input)?.[1];
    turn.finish();
    const written = await script(sessionId, `
      const key = await reins.secrets.get(${JSON.stringify(handle)});
      await reins.nodes.run("current", 'printf "%s\\\\n" "OPENAI_API_KEY=$OPENAI_API_KEY" >> .env', { cwd: ${JSON.stringify(dir)}, env: { OPENAI_API_KEY: key } });
      return "written";`);

    expect(submitted.status).toBe(204);
    expect(turn.input).toContain("The user entered OPENAI_API_KEY and RESEND_API_KEY.");
    expect(turn.input).toContain("reins.secrets.get");
    expect(written).toBe("written");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`OPENAI_API_KEY=${VALUE}\n`);
    expect(transcript(sessionId)).not.toContain(VALUE);
    expect(transcript(sessionId)).not.toContain("re_123");
    expect((await call("requests")).body).toEqual([]);
    expect(await script(sessionId, `return await reins.secrets.get("sec_guessed")`)).toEqual({ error: expect.stringContaining("No secret has this handle") });
  });

  test("refuses values that are blank, span lines or are over 16 KiB, and names other than those asked for; the request stays open", async () => {
    const sessionId = await newSession();
    await script(sessionId, `return await reins.secrets.request({ names: ["KEY"] })`);
    const [request] = (await call("requests")).body;

    const refused = await Promise.all([
      call("submit", { id: request.id, values: { KEY: "" } }),
      call("submit", { id: request.id, values: { KEY: "one\ntwo" } }),
      call("submit", { id: request.id, values: { KEY: "x".repeat(16 * 1024 + 1) } }),
      call("submit", { id: request.id, values: { OTHER: "v" } }),
    ]);

    expect(refused.map(({ status }) => status)).toEqual([400, 400, 400, 400]);
    expect(refused[1]!.body.error).toBe("Each value must be one non-empty line of at most 16 KiB");
    expect((await call("requests")).body).toHaveLength(1);
    expect(model.turns).toEqual([]);
  });

  test("a cancelled request stores nothing and wakes the session saying so", async () => {
    const sessionId = await newSession();
    await script(sessionId, `return await reins.secrets.request({ names: ["KEY"] })`);
    const [request] = (await call("requests")).body;

    const cancelled = await call("cancel", { id: request.id });
    const turn = await model.nextTurn(sessionId);
    turn.finish();

    expect(cancelled.status).toBe(204);
    expect(turn.input).toContain("The user cancelled the request for KEY");
    expect((await call("stored")).body).toEqual([]);
    expect((await call("submit", { id: request.id, values: { KEY: "v" } })).status).toBe(404);
  });

  test("lists what it stores without values, and a deleted secret's handle no longer works", async () => {
    const sessionId = await newSession();
    await script(sessionId, `return await reins.secrets.request({ names: ["KEY"] })`);
    const [request] = (await call("requests")).body;
    await call("submit", { id: request.id, values: { KEY: VALUE } });
    const turn = await model.nextTurn(sessionId);
    const handle = /KEY: (sec_[\w-]+)/.exec(turn.input)?.[1];
    turn.finish();

    const { body: stored } = await call("stored");
    await call("remove", { id: stored[0].id });

    expect(stored).toEqual([{ id: expect.any(Number), name: "KEY", sessionId, createdAt: "2026-04-01T10:00:00.000Z", lastUsedAt: null }]);
    expect(JSON.stringify(stored)).not.toContain(handle);
    expect(await script(sessionId, `return await reins.secrets.get(${JSON.stringify(handle)})`)).toEqual({ error: expect.stringContaining("No secret has this handle") });
  });

  test("deletes a secret 7 days after its last use", async () => {
    const sessionId = await newSession();
    await script(sessionId, `return await reins.secrets.request({ names: ["USED", "UNUSED"] })`);
    const [request] = (await call("requests")).body;
    await call("submit", { id: request.id, values: { USED: "u", UNUSED: "n" } });
    const turn = await model.nextTurn(sessionId);
    const used = /USED: (sec_[\w-]+)/.exec(turn.input)?.[1];
    turn.finish();

    now = new Date("2026-04-05T10:00:00.000Z");
    await script(sessionId, `return await reins.secrets.get(${JSON.stringify(used)})`);
    now = new Date("2026-04-08T10:00:01.000Z");
    await extension!.expire();

    expect((await call("stored")).body.map((secret: { name: string; lastUsedAt: string }) => [secret.name, secret.lastUsedAt])).toEqual([["USED", "2026-04-05T10:00:00.000Z"]]);
    expect(await script(sessionId, `return await reins.secrets.get(${JSON.stringify(used)})`)).toBe("u");
  });

  test("tells agents that can script to request secrets instead of asking for them in chat", async () => {
    const context = { session: { id: "s", projectId: null, taskId: null }, task: null };

    const sections = await state.extensions.host.promptSections({ ...context, tools: null });
    const withoutExecute = await state.extensions.host.promptSections({ ...context, tools: ["read", "bash"] });

    expect(sections.join("\n")).toContain("reins.secrets.request");
    expect(sections.join("\n")).toContain("Never ask the user to paste one");
    expect(withoutExecute.join("\n")).not.toContain("reins.secrets");
  });
});
