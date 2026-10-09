/**
 * The `reins` command (`bun run reins …` from source). Non-interactive: arguments in, one exit code out,
 * and the last line of output says what happened. `reins help` (or `--help`) lists the commands;
 * `reins help <command>` or `reins <command> --help` shows one. No command, an unknown one or bad
 * arguments print usage to stderr and exit 2, never showing what was typed.
 *
 * A command is selected by its words, the leading arguments, and gets the rest. Add one by declaring it
 * (`defineCommand`, command.ts) and listing it below.
 */
import { EXIT_OK, EXIT_USAGE, processContext, type Command, type CommandContext } from "./command.js";
import { nodePairCommand } from "./node/pair.js";
import { nodeReloadCommand } from "./node/reload.js";

const commands: readonly Command[] = [nodePairCommand, nodeReloadCommand];

function commandList(): string {
  const width = Math.max(...commands.map(command => command.usage.length));
  return [
    "Usage: reins <command> [arguments]",
    "",
    "Commands:",
    ...commands.map(command => `  ${command.usage.padEnd(width)}  ${command.summary}`),
    "",
    "Run \"reins help <command>\" or \"reins <command> --help\" for its options.",
  ].join("\n");
}

/** The command whose words lead `argv`. */
function find(argv: readonly string[]): Command | undefined {
  return commands.find(command => command.words.every((word, i) => argv[i] === word));
}

/** Runs one command line; resolves with its exit code. */
export async function runCli(argv: readonly string[], context: CommandContext = processContext()): Promise<number> {
  const command = find(argv);
  if (command) return command.invoke(argv.slice(command.words.length), context);

  if (argv.length === 1 && (argv[0] === "help" || argv[0] === "--help")) {
    context.out(commandList());
    return EXIT_OK;
  }
  const helped = argv[0] === "help" ? find(argv.slice(1)) : undefined;
  if (helped && argv.length === 1 + helped.words.length) {
    context.out(helped.help);
    return EXIT_OK;
  }
  context.err(`${commandList()}\n${argv.length === 0 ? "No command given." : "Unknown command."}`);
  return EXIT_USAGE;
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2)));
