import { expect, test } from "bun:test";
import { defineCommand, EXIT_OK, UsageError, type CommandContext } from "./command.js";

/** A command that records what it was given. */
function echo() {
  const calls: unknown[] = [];
  const command = defineCommand({
    words: ["thing", "do"],
    args: ["source path", "target?"],
    options: {
      force: { type: "boolean", description: "Do it anyway" },
      name: { type: "string", value: "label", description: "Call it this" },
    },
    summary: "Does a thing",
    async run({ args: [source, target], options }, { out }) {
      calls.push({ source, target, force: options.force, name: options.name });
      if (source === "bad") throw new UsageError("The source must not be bad.");
      if (source === "broken") throw new Error("disk on fire");
      out("done");
      return EXIT_OK;
    },
  });
  return { command, calls };
}

async function invoke(command: ReturnType<typeof echo>["command"], ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const context: CommandContext = { env: {}, out: text => out.push(text), err: text => err.push(text) };
  const exitCode = await command.invoke(argv, context);
  return { exitCode, out: out.join("\n"), err: err.join("\n") };
}

test("the usage line and help come from the declaration", () => {
  const { command } = echo();

  expect(command.usage).toBe("reins thing do <source path> [target] [--force] [--name <label>]");
  expect(command.help).toBe([
    "Usage: reins thing do <source path> [target] [--force] [--name <label>]",
    "Does a thing",
    "",
    "Options:",
    "  --force         Do it anyway",
    "  --name <label>  Call it this",
  ].join("\n"));
});

test("runs with its arguments and options parsed as declared, -- allowing an argument that starts with -", async () => {
  const { command, calls } = echo();

  expect(await invoke(command, "a")).toEqual({ exitCode: 0, out: "done", err: "" });
  await invoke(command, "--force", "a", "b", "--name=x");
  await invoke(command, "--name", "y", "--", "-a");

  expect(calls).toEqual([
    { source: "a", target: undefined, force: false, name: undefined },
    { source: "a", target: "b", force: true, name: "x" },
    { source: "-a", target: undefined, force: false, name: "y" },
  ]);
});

test("--help shows the help on stdout and runs nothing, unless it comes after --", async () => {
  const { command, calls } = echo();

  expect(await invoke(command, "--bogus", "--help")).toEqual({ exitCode: 0, out: command.help, err: "" });
  expect(calls).toEqual([]);
  await invoke(command, "--", "--help");
  expect(calls).toEqual([{ source: "--help", target: undefined, force: false, name: undefined }]);
});

test("bad arguments print the usage line and what is wrong, never the arguments, and exit 2 without running", async () => {
  const { command, calls } = echo();
  const usage = `Usage: ${command.usage}`;

  for (const [argv, problem] of [
    [[], "Missing <source path>."],
    [["s3cret", "b", "c"], "Too many arguments."],
    [["s3cret", "-s3cret"], "Unknown option. An argument that starts with \"-\" goes after \"--\"."],
    [["s3cret", "--force=s3cret"], "An option is missing its value or has one it does not take."],
    [["s3cret", "--name"], "An option is missing its value or has one it does not take."],
  ] as const) {
    expect({ argv, ...await invoke(command, ...argv) }).toEqual({ argv, exitCode: 2, out: "", err: `${usage}\n${problem}` });
  }
  expect(calls).toEqual([]);
});

test("a usage error from the command exits 2 with its message; any other error exits 1 with its message", async () => {
  const { command } = echo();

  expect(await invoke(command, "bad")).toEqual({ exitCode: 2, out: "", err: `Usage: ${command.usage}\nThe source must not be bad.` });
  expect(await invoke(command, "broken")).toEqual({ exitCode: 1, out: "", err: "reins thing do failed: disk on fire" });
});

test("a declaration with a required argument after an optional one, or a --help option, is refused", () => {
  expect(() => defineCommand({ words: ["x"], args: ["a?", "b"], options: {}, summary: "", run: async () => 0 })).toThrow("optional");
  expect(() => defineCommand({ words: ["x"], args: [], options: { help: { type: "boolean", description: "" } }, summary: "", run: async () => 0 })).toThrow("--help");
});
