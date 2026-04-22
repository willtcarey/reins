#!/usr/bin/env bun

/**
 * Capture a real compact-event trace from the Claude SDK.
 *
 * Finds an existing session in our DB (or accepts an explicit session ID),
 * resumes it, sends "/compact", and logs every SDK stream message to a JSON
 * fixture file for analysis.
 *
 * Usage:
 *   bun run packages/backend/scripts/capture-compact-trace.ts [sessionId]
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "path";
import {
  query,
  type HookInput,
  type HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { getDb } from "../src/db.js";
import { listProjects } from "../src/project-store.js";
import { listSessions } from "../src/session-store.js";
import { serializeForJson } from "./lib/claude-sdk-trace-capture.js";
import { resolveClaudeBinary } from "../src/runtimes/claude_agent_sdk/resolve-binary.js";

const CWD = process.cwd();
const OUTPUT_PATH = resolve(CWD, "tmp/compact-trace.json");

// ---------------------------------------------------------------------------
// SDK message type extraction (mirrors lib/claude-sdk-trace-capture.ts)
// ---------------------------------------------------------------------------

function getSdkMessageType(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "unknown";
  const typed = entry as {
    type?: unknown;
    subtype?: unknown;
    event?: { type?: unknown };
  };
  const type = typeof typed.type === "string" ? typed.type : "unknown";
  const subtype = typeof typed.subtype === "string" ? typed.subtype : null;
  const eventType =
    typed.event && typeof typed.event.type === "string"
      ? typed.event.type
      : null;

  if (type === "stream_event" && eventType) return `${type}.${eventType}`;
  if (subtype) return `${type}.${subtype}`;
  return type;
}

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

  console.error(`Found ${projects.length} project(s):`);
  for (const p of projects) {
    console.error(`  - [${p.id}] ${p.name} (${p.path})`);
  }

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

  // Find the most recent session with messages
  let best: FoundSession | null = null;

  for (const project of projects) {
    const sessions = listSessions(project.id);
    console.error(
      `  Project "${project.name}" has ${sessions.length} session(s):`,
    );
    for (const s of sessions.slice(0, 5)) {
      const preview = s.first_message?.slice(0, 60) ?? "(no first message)";
      console.error(
        `    - ${s.id.slice(0, 8)}… msgs=${s.message_count} name=${s.name ?? "—"} | ${preview}`,
      );
    }

    for (const s of sessions) {
      if (
        s.message_count > 0 &&
        (!best || s.message_count > best.messageCount)
      ) {
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

// State captured by the PostCompact hook
let postCompactSummary: string | null = null;

try {
  console.error("[compact-trace] Initializing DB…");
  getDb();

  const targetSessionId = process.argv[2];
  const found = findSession(targetSessionId);

  console.error();
  console.error(`[compact-trace] Selected session: ${found.sessionId}`);
  console.error(
    `[compact-trace]   Project: ${found.projectName} (${found.projectPath})`,
  );
  console.error(
    `[compact-trace]   Name: ${found.sessionName ?? "—"}`,
  );
  console.error(
    `[compact-trace]   Message count: ${found.messageCount}`,
  );
  console.error();

  const claudeBinary = resolveClaudeBinary();
  console.error(`[compact-trace] Claude binary: ${claudeBinary}`);
  console.error(`[compact-trace] Output: ${OUTPUT_PATH}`);
  console.error();

  const sdkMessages: unknown[] = [];
  let capturedError: unknown | null = null;

  const handle = query({
    prompt: "/compact",
    options: {
      cwd: found.projectPath,
      resume: found.sessionId,
      model: "sonnet",
      tools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      persistSession: true,
      settingSources: [],
      strictMcpConfig: true,
      systemPrompt: "You are a helpful assistant.",
      pathToClaudeCodeExecutable: claudeBinary,
      hooks: {
        PostCompact: [
          {
            hooks: [
              async (
                input: HookInput,
                _toolUseId: string | undefined,
                _options: { signal: AbortSignal },
              ): Promise<HookJSONOutput> => {
                if (input.hook_event_name === "PostCompact") {
                  postCompactSummary = input.compact_summary;
                  console.error(
                    `[compact-trace] PostCompact hook fired, summary length=${input.compact_summary.length}`,
                  );
                }
                return { continue: true };
              },
            ],
          },
        ],
      },
    },
  });

  try {
    for await (const sdkMessage of handle) {
      const serialized = serializeForJson(sdkMessage);
      const msgType = getSdkMessageType(serialized);
      console.error(`[compact-trace] ${msgType}`);
      sdkMessages.push(serialized);
    }
  } catch (error) {
    capturedError = serializeForJson(error);
    console.error(
      `[compact-trace] Error during stream: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    handle?.close?.();
  }

  // Build summary
  const messageTypes = sdkMessages.map(getSdkMessageType);
  const typeCounts = new Map<string, number>();
  for (const t of messageTypes) {
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }

  const artifact = {
    version: 1,
    capturedAt: new Date().toISOString(),
    sessionId: found.sessionId,
    projectPath: found.projectPath,
    projectName: found.projectName,
    prompt: "/compact",
    sdkMessages,
    postCompactSummary,
    error: capturedError,
    summary: {
      totalMessages: sdkMessages.length,
      messageTypes,
      typeCounts: Object.fromEntries(typeCounts),
    },
  };

  // Write output
  await mkdir("tmp", { recursive: true });
  await Bun.write(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);

  // Print summary
  console.error();
  console.error("=== Compact Trace Summary ===");
  console.error(`  Total SDK messages: ${sdkMessages.length}`);
  console.error(`  PostCompact summary: ${postCompactSummary ? `${postCompactSummary.length} chars` : "(not captured)"}`);
  console.error("  Message type counts:");
  for (const [type, count] of typeCounts) {
    console.error(`    ${type}: ${count}`);
  }
  console.error();
  console.error(`  Written to: ${OUTPUT_PATH}`);

  if (capturedError) {
    console.error(
      "[compact-trace] Completed with error; see JSON artifact for details.",
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    `[compact-trace] Fatal: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
