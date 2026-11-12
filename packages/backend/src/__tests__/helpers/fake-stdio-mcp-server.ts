/**
 * A stdio MCP server for tests, run as its own process on a test node (`fakeStdioServer`): newline-delimited
 * JSON-RPC on stdin and stdout, written by hand so that it starts fast and does only what a test needs.
 *
 * Tools: `echo {text}`; `whoami`, its pid, working directory, arguments and `$FAKE_TOKEN`; `crash`, which writes
 * to stderr and exits 3. Each start appends `started <pid>` to `$FAKE_MCP_LOG` when it is set.
 */

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

/** The command and arguments that run it with this Bun. */
export const fakeStdioServer = { command: process.execPath, args: [import.meta.path] };

const tools = [
  { name: "echo", description: "Answers its text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "whoami", description: "Says where it runs", inputSchema: { type: "object" } },
  { name: "crash", description: "Ends the process", inputSchema: { type: "object" } },
];

type Request = { id?: number | string; method: string; params?: { protocolVersion?: string; name?: string; arguments?: { text?: string } } };

function send(message: object) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function text(value: string) {
  return { content: [{ type: "text", text: value }] };
}

function callTool(name: string | undefined, args: { text?: string } = {}) {
  switch (name) {
    case "echo": return text(args.text ?? "");
    case "whoami": return text(JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), token: process.env.FAKE_TOKEN ?? null }));
    case "crash":
      process.stderr.write("fatal: the fake server crashed on purpose\n");
      process.exit(3);
  }
  return { ...text(`Unknown tool ${name}`), isError: true };
}

function answer(request: Request) {
  switch (request.method) {
    case "initialize":
      return { protocolVersion: request.params?.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake-stdio", version: "1.0.0" } };
    case "ping": return {};
    case "tools/list": return { tools };
    case "tools/call": return callTool(request.params?.name, request.params?.arguments);
  }
  return null;
}

if (import.meta.main) {
  if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, `started ${process.pid}\n`);
  createInterface({ input: process.stdin }).on("line", line => {
    if (!line.trim()) return;
    const request: Request = JSON.parse(line);
    if (request.id === undefined) return;
    const result = answer(request);
    send(result ? { jsonrpc: "2.0", id: request.id, result } : { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unknown method ${request.method}` } });
  });
}
