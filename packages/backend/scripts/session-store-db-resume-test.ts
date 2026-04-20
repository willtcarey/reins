/**
 * Manual test: resume an existing Reins session using our DB-backed SessionStore.
 *
 * Reads persisted messages from the SQLite DB, feeds them through
 * createSessionStore's load(), and resumes the session via the SDK's query()
 * with a simple follow-up prompt.
 *
 * Usage:
 *   bun run packages/backend/scripts/session-store-db-resume-test.ts [sessionId]
 *
 * If no session ID is provided, lists available sessions and picks the most
 * recent one with messages.
 */
import { existsSync } from "fs";
import { join } from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getDb } from "../src/db.js";
import { listProjects } from "../src/project-store.js";
import { listSessions } from "../src/session-store.js";
import { createSessionStore } from "../src/runtimes/claude_agent_sdk/session-store.js";
import { loadMessagesForLLM } from "../src/session-store.js";

const CWD = process.cwd();

// ---------------------------------------------------------------------------
// Claude binary resolution
// ---------------------------------------------------------------------------

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
const SYSTEM_PROMPT = "You are a helpful assistant. Be concise.";

// ---------------------------------------------------------------------------
// Find a session to resume
// ---------------------------------------------------------------------------

interface FoundSession {
  sessionId: string;
  projectPath: string;
  projectName: string;
  sessionName: string | null;
  messageCount: number;
}

function findSession(targetSessionId?: string): FoundSession {
  const projects = listProjects();

  if (projects.length === 0) {
    throw new Error("No projects found in DB. Run a session first.");
  }

  console.log(`Found ${projects.length} project(s):`);
  for (const p of projects) {
    console.log(`  - [${p.id}] ${p.name} (${p.path})`);
  }
  console.log();

  // If a specific session ID was requested, find it
  if (targetSessionId) {
    for (const project of projects) {
      const sessions = listSessions(project.id);
      const match = sessions.find((s) => s.id === targetSessionId);
      if (match) {
        return {
          sessionId: match.id,
          projectPath: project.path,
          projectName: project.name,
          sessionName: match.name,
          messageCount: match.message_count,
        };
      }
    }
    throw new Error(`Session ${targetSessionId} not found in any project.`);
  }

  // Otherwise, find the most recent session with messages
  let best: FoundSession | null = null;

  for (const project of projects) {
    const sessions = listSessions(project.id);
    console.log(`  Project "${project.name}" has ${sessions.length} session(s):`);
    for (const s of sessions.slice(0, 5)) {
      const preview = s.first_message?.slice(0, 60) ?? "(no first message)";
      console.log(`    - ${s.id.slice(0, 8)}… msgs=${s.message_count} name=${s.name ?? "—"} | ${preview}`);
    }

    for (const s of sessions) {
      if (s.message_count > 0 && (!best || s.message_count > best.messageCount)) {
        best = {
          sessionId: s.id,
          projectPath: project.path,
          projectName: project.name,
          sessionName: s.name,
          messageCount: s.message_count,
        };
      }
    }
  }

  if (!best) {
    throw new Error("No sessions with messages found. Run a session first.");
  }

  return best;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("DB-backed SessionStore resume test");
  console.log("===================================");
  console.log();

  // 1. Initialize DB
  getDb();
  console.log("DB initialized.\n");

  // 2. Find session to resume
  const targetSessionId = process.argv[2];
  const found = findSession(targetSessionId);

  console.log();
  console.log(`Selected session: ${found.sessionId}`);
  console.log(`  Project: ${found.projectName} (${found.projectPath})`);
  console.log(`  Name: ${found.sessionName ?? "—"}`);
  console.log(`  Message count: ${found.messageCount}`);
  console.log();

  // 3. Verify DB has messages for this session
  const rawMessages = loadMessagesForLLM(found.sessionId);
  console.log(`loadMessagesForLLM() returned ${rawMessages.length} messages`);
  if (rawMessages.length === 0) {
    console.log("No messages found — nothing to resume. Exiting.");
    return;
  }
  for (const msg of rawMessages.slice(0, 10)) {
    const role = msg.role ?? "?";
    let preview = "";
    if (typeof msg.content === "string") {
      preview = msg.content.slice(0, 80);
    } else if (Array.isArray(msg.content)) {
      preview = msg.content
        .map((b: any) => {
          if (b.type === "text") return `text:"${(b.text ?? "").slice(0, 30)}…"`;
          if (b.type === "toolCall") return `toolCall:${b.name}`;
          if (b.type === "thinking") return "thinking";
          return b.type ?? "?";
        })
        .join(", ");
    }
    console.log(`  - role=${role} | ${preview}`);
  }
  if (rawMessages.length > 10) {
    console.log(`  ... and ${rawMessages.length - 10} more`);
  }
  console.log();

  // 4. Create the DB-backed session store and resume
  const store = createSessionStore(found.projectPath);

  console.log(`Resuming session ${found.sessionId}`);
  console.log('Sending: "Summarize what we\'ve discussed so far in one sentence."');
  console.log();

  let resultText = "";

  const session = query({
    prompt: "Summarize what we've discussed so far in one sentence.",
    options: {
      maxTurns: 1,
      model: "sonnet",
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "default",
      resume: found.sessionId,
      sessionStore: store,
      pathToClaudeCodeExecutable: CLAUDE_BINARY,
    },
  });

  for await (const event of session) {
    if (event.type === "result") {
      const result = event as { session_id: string; result?: string };
      resultText = result.result ?? "";
      console.log(`  Session ID: ${result.session_id}`);
      console.log(`  Result: ${resultText}`);
    }
  }

  // 5. Summary
  console.log();
  console.log("=== Summary ===");
  console.log(`  Session:     ${found.sessionId}`);
  console.log(`  DB messages: ${rawMessages.length}`);
  console.log(`  Result:      ${resultText.slice(0, 300)}`);
  console.log();
  console.log(resultText ? "PASS — got a response from resumed session" : "FAIL — no response");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
