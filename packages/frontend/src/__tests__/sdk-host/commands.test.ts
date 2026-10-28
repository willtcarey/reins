import { describe, expect, test } from "bun:test";
import type { Command, CommandContext } from "@reins/sdk";
import { testSdk } from "../helpers/reins-sdk.js";

const command = (name: string): Command => ({ name, description: `The ${name} command`, run: () => {} });

describe("commands.register", () => {
  test("lists a command by name until it is disposed, telling subscribers", () => {
    const { reins, commands } = testSdk();
    let changes = 0;
    commands.subscribe(() => { changes += 1; });

    const disposeNew = reins.commands.register(command("new"));
    reins.commands.register(command("compact"));
    expect(commands.list().map((registered) => registered.name)).toEqual(["compact", "new"]);

    disposeNew();
    disposeNew();
    expect(commands.list().map((registered) => registered.name)).toEqual(["compact"]);
    expect(changes).toBe(3);
  });

  test("refuses a second command of a name and a name that cannot follow a slash", () => {
    const { reins } = testSdk();
    reins.commands.register(command("compact"));

    expect(() => reins.commands.register(command("compact"))).toThrow();
    expect(() => reins.commands.register(command("Compact"))).toThrow();
    expect(() => reins.commands.register(command("two words"))).toThrow();
    expect(() => reins.commands.register(command(""))).toThrow();
  });
});

describe("CommandRegistry.invocation", () => {
  test("recognizes a message that starts with a command's name, with the text after it as its arguments", () => {
    const { reins, commands } = testSdk();
    const compact = command("compact");
    reins.commands.register(compact);

    expect(commands.invocation("/compact keep the API names ")).toEqual({ command: compact, args: "keep the API names" });
    expect(commands.invocation("  /compact")).toEqual({ command: compact, args: "" });
    expect(commands.invocation("/compact\nfirst line\nsecond line")).toEqual({ command: compact, args: "first line\nsecond line" });
  });

  test("recognizes no command elsewhere in a message, in a longer word or of a name nothing registered", () => {
    const { reins, commands } = testSdk();
    reins.commands.register(command("compact"));

    expect(commands.invocation("please /compact")).toBeNull();
    expect(commands.invocation("/compacting now")).toBeNull();
    expect(commands.invocation("/dip start the server")).toBeNull();
    expect(commands.invocation("compact")).toBeNull();
  });
});

describe("CommandRegistry.run", () => {
  test("runs a command with the text after its name", async () => {
    const runs: CommandContext[] = [];
    const { reins, commands } = testSdk();
    reins.commands.register({ name: "compact", description: "Compact", run: (context) => { runs.push(context); } });
    const invocation = commands.invocation("/compact keep the API names");
    if (!invocation) throw new Error("Expected /compact to be a command");

    await commands.run(invocation);

    expect(runs).toEqual([{ args: "keep the API names" }]);
  });

  test("rejects with what the command threw", async () => {
    const { reins, commands } = testSdk();
    reins.commands.register({ name: "new", description: "New", run: () => { throw new Error("There is no project here to start a session in"); } });
    const invocation = commands.invocation("/new");
    if (!invocation) throw new Error("Expected /new to be a command");

    await expect(commands.run(invocation)).rejects.toThrow("There is no project here to start a session in");
  });
});
