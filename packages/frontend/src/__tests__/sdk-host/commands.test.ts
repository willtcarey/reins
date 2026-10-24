import { describe, expect, test } from "bun:test";
import type { Command } from "@reins/sdk";
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
