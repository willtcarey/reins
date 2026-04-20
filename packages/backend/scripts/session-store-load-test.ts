/**
 * End-to-end load test for our SessionStore `load()` implementation.
 *
 * Tests the full round-trip:
 *   1. Run a session with tool calls (reads package.json)
 *   2. Persist via transformClaudeSessionMessages() → AgentRuntimeMessage[]
 *   3. Resume using toSessionStoreEntries() in a SessionStore.load()
 *   4. Verify the resumed session has context from phase 1
 *
 * Usage:
 *   bun run packages/backend/scripts/session-store-load-test.ts
 */
import { existsSync } from "fs";
import { join } from "path";
import {
  query,
  getSessionMessages,
  type SessionStore,
  type SessionKey,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { transformClaudeSessionMessages } from "../src/runtimes/claude_agent_sdk/events.js";
import { toSessionStoreEntries } from "../src/runtimes/claude_agent_sdk/session-store.js";
import type { AgentRuntimeMessage } from "../src/runtimes/registry.js";

const CWD = process.cwd();

/**
 * Resolve the Claude Code binary path.
 *
 * Bun installs platform-specific optional deps under node_modules/.bun/.
 * The SDK defaults to the musl variant which doesn't work on glibc systems,
 * so we resolve the glibc binary explicitly.
 */
function resolveClaudeBinary(): string {
  const candidates = [
    // SDK-bundled glibc binary (preferred on this system)
    join(
      CWD,
      "node_modules/.bun/@anthropic-ai+claude-agent-sdk-linux-x64@0.2.114",
      "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
    ),
    // System-installed claude binary
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

const SYSTEM_PROMPT = `You are a helpful coding assistant. Always be concise in your responses.`;

// ---------------------------------------------------------------------------
// Phase 1: Create a session with tool calls
// ---------------------------------------------------------------------------

async function phase1(store: SessionStore): Promise<{ sessionId: string; resultText: string }> {
  console.log("=== Phase 1: Create session with tool calls ===");
  console.log(`  Asking model to read ${CWD}/packages/backend/package.json`);
  console.log();

  let sessionId: string | null = null;
  let resultText = "";

  const session = query({
    prompt: `Read the file at ${CWD}/packages/backend/package.json and tell me the project name from it. Be concise.`,
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
      const result = event as { session_id: string; result?: string };
      sessionId = result.session_id;
      resultText = result.result ?? "";
      console.log(`  Session ID: ${sessionId}`);
      console.log(`  Result: ${resultText.slice(0, 300)}`);
    }
  }

  if (!sessionId) {
    throw new Error("No session ID captured from phase 1");
  }

  return { sessionId, resultText };
}

// ---------------------------------------------------------------------------
// Phase 2: Persist to our format
// ---------------------------------------------------------------------------

async function phase2(sessionId: string): Promise<AgentRuntimeMessage[]> {
  console.log();
  console.log("=== Phase 2: Persist to our AgentRuntimeMessage[] format ===");

  // Small delay to let SDK flush session data
  await new Promise((r) => setTimeout(r, 500));

  const rawMessages = await getSessionMessages(sessionId, {
    includeSystemMessages: true,
  });

  console.log(`  Raw SDK messages: ${rawMessages.length}`);
  for (const msg of rawMessages) {
    console.log(`    - type=${msg.type}`);
  }

  const translated = transformClaudeSessionMessages(rawMessages);

  console.log();
  console.log(`  Translated AgentRuntimeMessages: ${translated.length}`);
  for (const msg of translated) {
    const preview = typeof msg.content === "string"
      ? msg.content.slice(0, 80)
      : Array.isArray(msg.content)
        ? msg.content
            .map((b: any) => {
              if (b.type === "text") return `text:"${b.text?.slice(0, 40)}..."`;
              if (b.type === "toolCall") return `toolCall:${b.name}(${Object.keys(b.arguments || {}).join(",")})`;
              if (b.type === "thinking") return "thinking:...";
              return b.type;
            })
            .join(", ")
        : "?";
    console.log(`    - role=${msg.role} | ${preview}`);
  }

  return translated;
}

// ---------------------------------------------------------------------------
// Phase 3: Resume using our SessionStore
// ---------------------------------------------------------------------------

async function phase3(
  originalSessionId: string,
  messages: AgentRuntimeMessage[],
  store: SessionStore,
): Promise<string> {
  console.log();
  console.log("=== Phase 3: Resume using our SessionStore.load() ===");

  // Use a fresh session ID so the SDK doesn't conflict with its own local
  // JSONL files from phase 1 (which would bypass our SessionStore).
  const resumeSessionId = crypto.randomUUID();
  console.log(`  Original session: ${originalSessionId}`);
  console.log(`  Resume session:   ${resumeSessionId}`);

  const entries = toSessionStoreEntries(messages, { sessionId: resumeSessionId, cwd: CWD });

  console.log(`  toSessionStoreEntries() produced ${entries.length} entries:`);
  for (const entry of entries) {
    const msg = (entry as any).message;
    const roleStr = msg?.role ?? "?";
    let contentPreview = "";
    if (typeof msg?.content === "string") {
      contentPreview = msg.content.slice(0, 60);
    } else if (Array.isArray(msg?.content)) {
      contentPreview = msg.content
        .map((b: any) => {
          if (b.type === "text") return `text:"${(b.text ?? "").slice(0, 30)}..."`;
          if (b.type === "tool_use") return `tool_use:${b.name}`;
          if (b.type === "tool_result") return `tool_result:${b.tool_use_id?.slice(0, 12)}...`;
          if (b.type === "thinking") return "thinking";
          return b.type ?? "?";
        })
        .join(", ");
    }
    console.log(`    - type=${entry.type} role=${roleStr} uuid=${entry.uuid} | ${contentPreview}`);
  }

  store.load = async (_key: SessionKey) => {
    console.log(`  [store.load] Called for session ${_key.sessionId}`);
    console.log(`  [store.load] Returning ${entries.length} translated entries`);
    return entries;
  };

  console.log();
  console.log(`  Resuming session ${resumeSessionId}`);
  console.log(`  Asking: "What file did you just read? What was the project name?"`);
  console.log();

  let resultText = "";

  const session = query({
    prompt:
      "What file did you just read? What was the project name from it?",
    options: {
      maxTurns: 1,
      model: "sonnet",
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "default",
      resume: resumeSessionId,
      sessionStore: store,
      pathToClaudeCodeExecutable: CLAUDE_BINARY,
    },
  });

  for await (const event of session) {
    if (event.type === "result") {
      const result = event as { result?: string };
      resultText = result.result ?? "";
      console.log(`  Result: ${resultText.slice(0, 500)}`);
    }
  }

  return resultText;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("SessionStore load() end-to-end test");
  console.log("====================================");
  console.log();

  // Shared store: append is a no-op (SDK uses local JSONL for phase 1),
  // load returns null during phase 1, then gets replaced in phase 3.
  const store: SessionStore = {
    async append(_key: SessionKey, _entries: SessionStoreEntry[]): Promise<void> {},
    async load(_key: SessionKey): Promise<SessionStoreEntry[] | null> { return null; },
    async listSubkeys(): Promise<string[]> { return []; },
  };

  const { sessionId, resultText: phase1Result } = await phase1(store);

  const messages = await phase2(sessionId);

  const phase3Result = await phase3(sessionId, messages, store);

  console.log();
  console.log("=== Summary ===");
  console.log(`  Phase 1 (original): ${phase1Result.slice(0, 200)}`);
  console.log(`  Phase 3 (resumed):  ${phase3Result.slice(0, 200)}`);

  const mentionsPackageJson =
    phase3Result.toLowerCase().includes("package.json");
  const mentionsProjectName =
    phase3Result.toLowerCase().includes("@reins/backend") ||
    phase3Result.toLowerCase().includes("reins");

  console.log();
  console.log("  === VERIFICATION ===");
  console.log(
    `  Mentions package.json:  ${mentionsPackageJson ? "YES ✓" : "NO ✗"}`,
  );
  console.log(
    `  Mentions project name:  ${mentionsProjectName ? "YES ✓" : "NO ✗"}`,
  );
  console.log(
    `  Verdict: ${mentionsPackageJson && mentionsProjectName ? "PASS — session context preserved!" : "NEEDS REVIEW"}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
