import { afterEach, expect, test } from "bun:test";
import { nodePairCommand } from "./node/pair.js";
import { lastLine, reins, spawnReins } from "./testing/reins.js";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

const LIST_END = "Run \"reins help <command>\" or \"reins <command> --help\" for its options.";

test("help lists every command with its usage, on stdout", async () => {
  for (const args of [["help"], ["--help"]]) {
    const run = await reins(args);
    expect({ args, exitCode: run.exitCode, stderr: run.stderr, last: lastLine(run.stdout) }).toEqual({ args, exitCode: 0, stderr: "", last: LIST_END });
    expect(run.stdout).toStartWith("Usage: reins <command> [arguments]\n");
    for (const usage of ["reins node pair <server URL> <code> [--force]", "reins node reload [nodeId] [--force] [--server <url>] [--local]"]) {
      expect(run.stdout).toContain(`  ${usage}  `);
    }
  }
});

test("help with a command's words, or the command with --help, shows that command", async () => {
  for (const args of [["help", "node", "pair"], ["node", "pair", "https://reins.example", "--help"]]) {
    expect({ args, ...await reins(args) }).toMatchObject({ args, exitCode: 0, stdout: `${nodePairCommand.help}\n`, stderr: "" });
  }
});

test("no command, an unknown one, or words that do not lead print the commands to stderr and exit 2, never the arguments", async () => {
  for (const [args, last] of [
    [[], "No command given."],
    [["node"], "Unknown command."],
    [["node", "unpair", "s3cret"], "Unknown command."],
    [["--force", "node", "pair", "https://reins.example", "s3cret"], "Unknown command."],
    [["help", "s3cret"], "Unknown command."],
  ] as const) {
    const run = await reins(args);
    expect({ args, exitCode: run.exitCode, stdout: run.stdout, last: lastLine(run.stderr) }).toEqual({ args, exitCode: 2, stdout: "", last });
    expect(run.stderr).toStartWith("Usage: reins <command> [arguments]\n");
    expect(run.output).not.toContain("s3cret");
  }
});

test("the process exits with the command's code, its output on stdout and its errors on stderr", async () => {
  server = Bun.serve({ port: 0, fetch: () => Response.json({ scheduled: true }) });

  const scheduled = await spawnReins(["node", "reload", "--local"], { REINS_PORT: String(server.port), REINS_NODE_ID: undefined });
  expect({ exitCode: scheduled.exitCode, stderr: scheduled.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(lastLine(scheduled.stdout)).toStartWith("Node internal reload scheduled");

  const usage = await spawnReins(["node", "pair"]);
  expect({ exitCode: usage.exitCode, stdout: usage.stdout }).toEqual({ exitCode: 2, stdout: "" });
  expect(lastLine(usage.stderr)).toBe("Missing <server URL> <code>.");
});
