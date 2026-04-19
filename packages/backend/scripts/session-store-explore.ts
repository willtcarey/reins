/**
 * Exploration script for the SessionStore API added in claude-agent-sdk 0.2.114.
 *
 * Tests mid-conversation rewrite: runs a session that establishes a fact
 * ("favorite color is blue"), then on resume the store's load() rewrites
 * "blue" → "red" in the transcript. Verifies the model sees the rewritten
 * content by asking it to recall the fact.
 *
 * Usage:
 *   bun run packages/backend/scripts/session-store-explore.ts
 */
import {
  query,
  type SessionStore,
  type SessionKey,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, writeFileSync } from "fs";
import { join } from "path";

const LOG_FILE = join(import.meta.dir, "session-store-explore.txt");

const SYSTEM_PROMPT = `You are a helpful coding assistant with access to a Read tool.

## Read Tool

Reads a file from the local filesystem.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- Results are returned using cat -n format, with line numbers starting at 1

Parameters:
- file_path (string, required): The absolute path to the file to read
- offset (number, optional): The line number to start reading from
- limit (number, optional): The number of lines to read

Always be concise in your responses.`;

function printUsage(label: string, usage: any) {
  if (!usage) return;
  console.log(`\n  ${label} — prompt cache usage:`);
  console.log(`    input_tokens:                ${usage.input_tokens}`);
  console.log(`    cache_read_input_tokens:     ${usage.cache_read_input_tokens}`);
  console.log(`    cache_creation_input_tokens: ${usage.cache_creation_input_tokens}`);
  console.log(`    output_tokens:               ${usage.output_tokens}`);
}

function log(method: string, args: Record<string, unknown>, result?: unknown) {
  const entry = {
    time: new Date().toISOString(),
    method,
    args,
    ...(result !== undefined ? { result } : {}),
  };
  appendFileSync(LOG_FILE, JSON.stringify(entry, null, 2) + "\n---\n");
}

/**
 * Mid-conversation rewrite test.
 *
 * 1. Run a session where the user says "My favorite color is blue. Remember that."
 * 2. The store captures the entries via append().
 * 3. On load(), the store rewrites "blue" → "red" in all text content.
 * 4. Resume the session and ask "What is my favorite color?"
 * 5. The model should say "red" (the rewritten value), not "blue".
 */

function createRewriteStore(): {
  store: SessionStore;
  capturedSessionId: string | null;
} {
  const storage = new Map<string, SessionStoreEntry[]>();
  const state = { capturedSessionId: null as string | null };

  const store: SessionStore = {
    async append(key: SessionKey, entries: SessionStoreEntry[]) {
      const existing = storage.get(key.sessionId) ?? [];
      storage.set(key.sessionId, [...existing, ...entries]);
      state.capturedSessionId = key.sessionId;
      log("append", {
        key,
        entryCount: entries.length,
        entryTypes: entries.map((e) => e.type),
      });
      for (const entry of entries) {
        log("append.entry", { entry });
      }
    },

    async load(key: SessionKey) {
      const entries = storage.get(key.sessionId);
      if (!entries) {
        log("load", { key, result: "no entries found" });
        return null;
      }

      // Deep-clone then rewrite "blue" → "red" in all text content
      const rewritten = JSON.parse(JSON.stringify(entries)) as SessionStoreEntry[];
      let rewrites = 0;

      for (const entry of rewritten) {
        const msg = (entry as any).message;
        if (!msg?.content) continue;
        if (typeof msg.content === "string") {
          if (msg.content.includes("blue")) {
            msg.content = msg.content.replaceAll("blue", "red");
            rewrites++;
          }
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text" && typeof block.text === "string" && block.text.includes("blue")) {
              block.text = block.text.replaceAll("blue", "red");
              rewrites++;
            }
          }
        }
      }

      log("load", {
        key,
        entryCount: rewritten.length,
        rewrites,
      });
      console.log(`  [store.load] Returning ${rewritten.length} entries with ${rewrites} rewrites (blue→red)`);
      return rewritten;
    },

    async listSubkeys() {
      return [];
    },
  };

  return { store, get capturedSessionId() { return state.capturedSessionId; } };
}

async function main() {
  writeFileSync(
    LOG_FILE,
    `=== Mid-Conversation Rewrite Test - ${new Date().toISOString()} ===\n\n`
  );
  console.log(`Logging to: ${LOG_FILE}\n`);

  const storeRef = createRewriteStore();

  // --- Step 1: Initial session — establish "blue" as the favorite color ---
  console.log(`--- Step 1: Establishing favorite color as BLUE ---`);

  let sessionId: string | null = null;

  const session1 = query({
    prompt: "My favorite color is blue. Remember that.",
    options: {
      maxTurns: 1,
      model: "sonnet",
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "default",
      sessionStore: storeRef.store,
    },
  });

  for await (const event of session1) {
    if (event.type === "assistant" && "message" in event) {
      const msg = (event as any).message;
      console.log(`  Model: ${msg?.model}`);
      printUsage("Step 1", msg?.usage);
    }
    if (event.type === "result") {
      console.log(`\n  Step 1 result: ${event.result?.slice(0, 300)}`);
      // Grab the session ID from the store
      sessionId = storeRef.capturedSessionId;
      console.log(`  Captured sessionId: ${sessionId}`);
    }
  }

  if (!sessionId) {
    throw new Error("No sessionId captured from step 1");
  }

  // --- Step 2: Resume with rewrite — ask what the favorite color is ---
  console.log(`\n--- Step 2: Resuming session (load will rewrite blue→red) ---`);
  console.log(`  Asking: "What is my favorite color?"`);

  const session2 = query({
    prompt: "What is my favorite color?",
    options: {
      maxTurns: 1,
      model: "sonnet",
      tools: [],
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "default",
      resume: sessionId,
      sessionStore: storeRef.store,
    },
  });

  for await (const event of session2) {
    if (event.type === "assistant" && "message" in event) {
      const msg = (event as any).message;
      console.log(`  Model: ${msg?.model}`);
      printUsage("Step 2", msg?.usage);
    }
    if (event.type === "result") {
      const result = event.result ?? "";
      console.log(`\n  Step 2 result: ${result.slice(0, 300)}`);

      // Check if the rewrite worked
      const saysRed = result.toLowerCase().includes("red");
      const saysBlue = result.toLowerCase().includes("blue");
      console.log(`\n  === REWRITE TEST ===`);
      console.log(`  Says "red":  ${saysRed ? "YES ✓" : "NO ✗"}`);
      console.log(`  Says "blue": ${saysBlue ? "YES (unexpected)" : "NO ✓"}`);
      console.log(`  Verdict: ${saysRed && !saysBlue ? "PASS — rewrite worked!" : "NEEDS REVIEW"}`);
    }
  }

  console.log(`\nDone. Review log at: ${LOG_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
