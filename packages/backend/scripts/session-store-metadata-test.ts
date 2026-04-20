/**
 * Systematic test: which metadata fields on SessionStoreEntry are required for resume?
 *
 * Runs a single session (phase 1), captures raw entries via append(), then attempts
 * to resume under multiple stripping strategies to isolate exactly which fields matter.
 *
 * Scenarios (no-tool):
 *   1. Raw entries (baseline) — should work
 *   2. Raw entries, user/assistant only (drop queue-operation, ai-title, etc.) — should work
 *   3. Stripped to type + message + uuid + parentUuid only — expected to fail
 *   4. Stripped to type + message + uuid + parentUuid + sessionId — expected to fail
 *   5. Raw metadata + our translated message objects (grafted) — expected to fail differently
 *
 * Scenarios (tool-call):
 *   7. Raw entries, user/assistant only (baseline for tool calls)
 *   8. Stripped to type + message + uuid + parentUuid + sessionId + cwd + timestamp
 *   9. Stripped to type + message + uuid + parentUuid only
 *
 * Usage:
 *   bun run packages/backend/scripts/session-store-metadata-test.ts
 */
import { existsSync } from "fs";
import { join } from "path";
import {
  query,
  type SessionStore,
  type SessionKey,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { transformClaudeSessionMessages } from "../src/runtimes/claude_agent_sdk/events.js";
import { toSessionStoreEntries } from "../src/runtimes/claude_agent_sdk/session-store.js";

const CWD = process.cwd();

function resolveClaudeBinary(): string {
  const candidates = [
    join(
      CWD,
      "node_modules/.bun/@anthropic-ai+claude-agent-sdk-linux-x64@0.2.114",
      "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
    ),
    join(process.env.HOME ?? "", ".local/bin/claude"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Could not find Claude binary. Checked:\n${candidates.map((c) => `  - ${c}`).join("\n")}`,
  );
}

const CLAUDE_BINARY = resolveClaudeBinary();
const SYSTEM_PROMPT = "You are a helpful assistant. Always be concise.";

// ---------------------------------------------------------------------------
// Phase 1: Run a session with a simple exchange to capture raw entries
// ---------------------------------------------------------------------------

async function runInitialSession(): Promise<{
  sessionId: string;
  rawEntries: SessionStoreEntry[];
}> {
  console.log("=== Phase 1: Run initial session ===");

  const rawEntries: SessionStoreEntry[] = [];
  let sessionId: string | null = null;

  const store: SessionStore = {
    async append(key: SessionKey, entries: SessionStoreEntry[]) {
      rawEntries.push(...entries);
      sessionId = key.sessionId;
    },
    async load() { return null; },
    async listSubkeys() { return []; },
  };

  const session = query({
    prompt: "My favorite number is 42 and my favorite color is green. Remember both of those facts.",
    options: {
      maxTurns: 1,
      model: "sonnet",
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "default",
      sessionStore: store,
      pathToClaudeCodeExecutable: CLAUDE_BINARY,
    },
  });

  for await (const event of session) {
    if (event.type === "result") {
      console.log(`  Result: ${(event.result ?? "").slice(0, 200)}`);
    }
  }

  if (!sessionId) throw new Error("No session ID captured");
  console.log(`  Session ID: ${sessionId}`);
  console.log(`  Raw entries captured: ${rawEntries.length}`);
  console.log(`  Entry types: ${rawEntries.map((e) => e.type).join(", ")}`);
  console.log();

  return { sessionId, rawEntries };
}

// ---------------------------------------------------------------------------
// Phase 1b: Run a session with a tool call (Read) to capture raw entries
// ---------------------------------------------------------------------------

async function runToolCallSession(): Promise<{
  sessionId: string;
  rawEntries: SessionStoreEntry[];
}> {
  console.log("=== Phase 1b: Run tool-call session ===");

  const rawEntries: SessionStoreEntry[] = [];
  let sessionId: string | null = null;

  const store: SessionStore = {
    async append(key: SessionKey, entries: SessionStoreEntry[]) {
      rawEntries.push(...entries);
      sessionId = key.sessionId;
    },
    async load() { return null; },
    async listSubkeys() { return []; },
  };

  const session = query({
    prompt: "Read the file at packages/backend/package.json and tell me the project name from it.",
    options: {
      maxTurns: 2,
      model: "sonnet",
      tools: ["Read"],
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "default",
      sessionStore: store,
      pathToClaudeCodeExecutable: CLAUDE_BINARY,
    },
  });

  for await (const event of session) {
    if (event.type === "result") {
      console.log(`  Result: ${(event.result ?? "").slice(0, 200)}`);
    }
  }

  if (!sessionId) throw new Error("No session ID captured for tool-call session");
  console.log(`  Session ID: ${sessionId}`);
  console.log(`  Raw entries captured: ${rawEntries.length}`);
  console.log(`  Entry types: ${rawEntries.map((e) => e.type).join(", ")}`);
  console.log();

  return { sessionId, rawEntries };
}

// ---------------------------------------------------------------------------
// Resume attempt helper
// ---------------------------------------------------------------------------

type Scenario = {
  name: string;
  description: string;
  buildEntries: (raw: SessionStoreEntry[]) => SessionStoreEntry[];
};

async function attemptResume(
  sessionId: string,
  scenario: Scenario,
  rawEntries: SessionStoreEntry[],
): Promise<{ success: boolean; result?: string; error?: string }> {
  const entries = scenario.buildEntries(rawEntries);

  console.log(`  Entries to return: ${entries.length}`);
  for (const e of entries) {
    const fields = Object.keys(e).sort().join(", ");
    console.log(`    type=${e.type} fields=[${fields}]`);
  }

  const store: SessionStore = {
    async append() {},
    async load() { return entries; },
    async listSubkeys() { return []; },
  };

  try {
    const session = query({
      prompt: "What is my favorite number and favorite color?",
      options: {
        maxTurns: 1,
        model: "sonnet",
        tools: [],
        systemPrompt: SYSTEM_PROMPT,
        permissionMode: "default",
        resume: sessionId,
        sessionStore: store,
        pathToClaudeCodeExecutable: CLAUDE_BINARY,
      },
    });

    let resultText = "";
    for await (const event of session) {
      if (event.type === "result") {
        resultText = (event as any).result ?? "";
      }
    }

    const mentions42 = resultText.includes("42");
    const mentionsGreen = resultText.toLowerCase().includes("green");

    return {
      success: mentions42 && mentionsGreen,
      result: resultText.slice(0, 300),
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message?.slice(0, 300) ?? String(err),
    };
  }
}

async function attemptResumeToolCall(
  sessionId: string,
  scenario: Scenario,
  rawEntries: SessionStoreEntry[],
): Promise<{ success: boolean; result?: string; error?: string }> {
  const entries = scenario.buildEntries(rawEntries);

  console.log(`  Entries to return: ${entries.length}`);
  for (const e of entries) {
    const fields = Object.keys(e).sort().join(", ");
    console.log(`    type=${e.type} fields=[${fields}]`);
  }

  const store: SessionStore = {
    async append() {},
    async load() { return entries; },
    async listSubkeys() { return []; },
  };

  try {
    const session = query({
      prompt: "What file did you read and what was the project name?",
      options: {
        maxTurns: 1,
        model: "sonnet",
        tools: [],
        systemPrompt: SYSTEM_PROMPT,
        permissionMode: "default",
        resume: sessionId,
        sessionStore: store,
        pathToClaudeCodeExecutable: CLAUDE_BINARY,
      },
    });

    let resultText = "";
    for await (const event of session) {
      if (event.type === "result") {
        resultText = (event as any).result ?? "";
      }
    }

    const mentionsPackageJson = resultText.toLowerCase().includes("package.json");
    const mentionsProjectName = resultText.toLowerCase().includes("reins") ||
      resultText.toLowerCase().includes("@reins/backend");

    return {
      success: mentionsPackageJson && mentionsProjectName,
      result: resultText.slice(0, 300),
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message?.slice(0, 300) ?? String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

const scenarios: Scenario[] = [
  {
    name: "1-raw",
    description: "Raw entries from append() — full metadata (baseline)",
    buildEntries: (raw) => {
      // Return only user/assistant entries (drop queue-operation, ai-title, etc.)
      // but keep all metadata on those entries
      return raw.filter((e) => e.type === "user" || e.type === "assistant");
    },
  },
  {
    name: "2-minimal",
    description: "Stripped to type + message + uuid + parentUuid only",
    buildEntries: (raw) => {
      return raw
        .filter((e) => e.type === "user" || e.type === "assistant")
        .map((e) => ({
          type: e.type,
          message: (e as any).message,
          uuid: e.uuid,
          parentUuid: (e as any).parentUuid,
        }));
    },
  },
  {
    name: "3-minimal-plus-sessionId",
    description: "Stripped to type + message + uuid + parentUuid + sessionId",
    buildEntries: (raw) => {
      return raw
        .filter((e) => e.type === "user" || e.type === "assistant")
        .map((e) => ({
          type: e.type,
          message: (e as any).message,
          uuid: e.uuid,
          parentUuid: (e as any).parentUuid,
          sessionId: (e as any).sessionId,
        }));
    },
  },
  {
    name: "4-minimal-plus-core-meta",
    description: "Stripped to type + message + uuid + parentUuid + sessionId + cwd + timestamp",
    buildEntries: (raw) => {
      return raw
        .filter((e) => e.type === "user" || e.type === "assistant")
        .map((e) => ({
          type: e.type,
          message: (e as any).message,
          uuid: e.uuid,
          parentUuid: (e as any).parentUuid,
          sessionId: (e as any).sessionId,
          cwd: (e as any).cwd,
          timestamp: (e as any).timestamp,
        }));
    },
  },
  {
    name: "5-translated",
    description: "Our toSessionStoreEntries() output (translated from AgentRuntimeMessage)",
    buildEntries: (raw) => {
      // Simulate: raw → getSessionMessages → transformClaudeSessionMessages → toSessionStoreEntries
      // But we can't call getSessionMessages without a real session file, so we'll
      // fabricate the minimal translated shape manually from the raw entries
      const conversationEntries = raw.filter((e) => e.type === "user" || e.type === "assistant");
      // Build entries that look like what toSessionStoreEntries would produce:
      // type + message (with our normalized content) + fresh uuid/parentUuid
      let prevUuid: string | undefined;
      return conversationEntries.map((e) => {
        const uuid = crypto.randomUUID();
        const entry: any = {
          type: e.type,
          message: (e as any).message, // keep raw message for this test
          uuid,
        };
        if (prevUuid) entry.parentUuid = prevUuid;
        prevUuid = uuid;
        return entry;
      });
    },
  },
  {
    name: "6-raw-new-uuids",
    description: "Raw entries with all metadata but UUIDs rewritten to fresh values",
    buildEntries: (raw) => {
      const conversationEntries = raw.filter((e) => e.type === "user" || e.type === "assistant");
      let prevUuid: string | undefined;
      return conversationEntries.map((e) => {
        const uuid = crypto.randomUUID();
        const clone: any = { ...e, uuid };
        if (prevUuid) {
          clone.parentUuid = prevUuid;
        } else {
          delete clone.parentUuid;
        }
        prevUuid = uuid;
        return clone;
      });
    },
  },
];

const toolCallScenarios: Scenario[] = [
  {
    name: "7-tools-raw",
    description: "Tool-call session: raw entries, user/assistant only (baseline)",
    buildEntries: (raw) => {
      return raw.filter((e) => e.type === "user" || e.type === "assistant");
    },
  },
  {
    name: "8-tools-core-meta",
    description: "Tool-call session: stripped to type + message + uuid + parentUuid + sessionId + cwd + timestamp",
    buildEntries: (raw) => {
      return raw
        .filter((e) => e.type === "user" || e.type === "assistant")
        .map((e) => ({
          type: e.type,
          message: (e as any).message,
          uuid: e.uuid,
          parentUuid: (e as any).parentUuid,
          sessionId: (e as any).sessionId,
          cwd: (e as any).cwd,
          timestamp: (e as any).timestamp,
        }));
    },
  },
  {
    name: "9-tools-minimal",
    description: "Tool-call session: stripped to type + message + uuid + parentUuid only",
    buildEntries: (raw) => {
      return raw
        .filter((e) => e.type === "user" || e.type === "assistant")
        .map((e) => ({
          type: e.type,
          message: (e as any).message,
          uuid: e.uuid,
          parentUuid: (e as any).parentUuid,
        }));
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { sessionId, rawEntries } = await runInitialSession();

  // Show what metadata fields exist on the raw entries
  console.log("=== Raw entry field analysis ===");
  for (const entry of rawEntries.filter((e) => e.type === "user" || e.type === "assistant").slice(0, 2)) {
    const { message, ...meta } = entry as any;
    console.log(`  type=${entry.type} metadata keys: ${Object.keys(meta).sort().join(", ")}`);
    if (message) {
      console.log(`  message keys: ${Object.keys(message).sort().join(", ")}`);
    }
  }
  console.log();

  // Run each no-tool scenario
  const results: Array<{ name: string; description: string; success: boolean; detail: string }> = [];

  for (const scenario of scenarios) {
    console.log(`\n=== Scenario ${scenario.name}: ${scenario.description} ===`);
    const result = await attemptResume(sessionId, scenario, rawEntries);

    const detail = result.success
      ? `PASS — ${result.result?.slice(0, 100)}`
      : result.error
        ? `FAIL — ${result.error}`
        : `FAIL (wrong answer) — ${result.result?.slice(0, 100)}`;

    console.log(`  → ${detail}`);
    results.push({ name: scenario.name, description: scenario.description, success: result.success, detail });
  }

  // Phase 1b: Tool-call session
  const { sessionId: toolSessionId, rawEntries: toolRawEntries } = await runToolCallSession();

  // Show what metadata fields exist on the tool-call raw entries
  console.log("=== Tool-call raw entry field analysis ===");
  for (const entry of toolRawEntries.filter((e) => e.type === "user" || e.type === "assistant").slice(0, 4)) {
    const { message, ...meta } = entry as any;
    console.log(`  type=${entry.type} metadata keys: ${Object.keys(meta).sort().join(", ")}`);
    if (message) {
      console.log(`  message keys: ${Object.keys(message).sort().join(", ")}`);
    }
  }
  console.log();

  // Run each tool-call scenario
  for (const scenario of toolCallScenarios) {
    console.log(`\n=== Scenario ${scenario.name}: ${scenario.description} ===`);
    const result = await attemptResumeToolCall(toolSessionId, scenario, toolRawEntries);

    const detail = result.success
      ? `PASS — ${result.result?.slice(0, 100)}`
      : result.error
        ? `FAIL — ${result.error}`
        : `FAIL (wrong answer) — ${result.result?.slice(0, 100)}`;

    console.log(`  → ${detail}`);
    results.push({ name: scenario.name, description: scenario.description, success: result.success, detail });
  }

  // Summary
  console.log("\n\n========================================");
  console.log("SUMMARY");
  console.log("========================================");
  for (const r of results) {
    const icon = r.success ? "✓" : "✗";
    console.log(`  ${icon} ${r.name}: ${r.description}`);
    console.log(`    ${r.detail}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
