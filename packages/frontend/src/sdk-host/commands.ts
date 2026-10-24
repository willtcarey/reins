import type { Command, Commands, Disposer } from "@reins/sdk";

const COMMAND_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** A message that runs a command: the command and the text after its name. */
export interface CommandInvocation {
  command: Command;
  args: string;
}

/** The registered commands, app state on `AppStore`: the composer runs and suggests them. */
export class CommandRegistry implements Commands {
  private commands = new Map<string, Command>();
  private listeners = new Set<() => void>();

  register(command: Command): Disposer {
    if (!COMMAND_NAME.test(command.name)) throw new Error(`"${command.name}" cannot be a command's name`);
    if (this.commands.has(command.name)) throw new Error(`The /${command.name} command is already registered`);
    this.commands.set(command.name, command);
    this.notify();
    return () => {
      if (this.commands.get(command.name) !== command) return;
      this.commands.delete(command.name);
      this.notify();
    };
  }

  /** The registered commands, by name. */
  list(): Command[] {
    return [...this.commands.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  /** The command `text` runs: it starts with `/name` of a registered command, then whitespace or its end. */
  invocation(text: string): CommandInvocation | null {
    const match = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const command = match && this.commands.get(match[1] ?? "");
    if (!command) return null;
    return { command, args: match[2]?.trim() ?? "" };
  }

  /** Listens for a command registered or gone. */
  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
