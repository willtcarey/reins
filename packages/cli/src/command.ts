/**
 * What a `reins` command is: a declaration (`defineCommand`) of its words, arguments and options, from
 * which this module parses the command line strictly, checks the arguments' count, writes the usage line
 * and `--help`, and reports bad arguments, so a command's `run` only gets what it declared. cli.ts lists
 * the commands.
 *
 * No error shows what was typed: an argument may be a secret (a pairing code).
 */
import { parseArgs } from "node:util";

export const EXIT_OK = 0;
/** An unexpected failure, or a command's own failure when it has no code of its own for it. */
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
/** No server answered, or not as a Reins server would (server.ts). */
export const EXIT_UNREACHABLE = 5;

export type Env = Record<string, string | undefined>;

/** Where a command runs: its environment and its output. */
export interface CommandContext {
  env: Env;
  /** Prints text (a line or more) to stdout. */
  out(text: string): void;
  /** Prints text (a line or more) to stderr. */
  err(text: string): void;
}

/** The process's environment, stdout and stderr. */
export function processContext(): CommandContext {
  return { env: process.env, out: text => console.log(text), err: text => console.error(text) };
}

export type OptionSpec =
  | { type: "boolean"; description: string }
  /** `value` names its value in the usage line: `--server <url>`. */
  | { type: "string"; value: string; description: string };
export type OptionSpecs = Readonly<Record<string, OptionSpec>>;

/** Positional arguments by name, as the usage line shows them; a trailing `?` makes one optional
 * (`nodeId?` → `[nodeId]`). Optional arguments come last. */
export type ArgSpecs = readonly string[];

/** A command's positionals as `run` gets them: a tuple, `undefined` for an optional one not given. */
export type ArgValues<A extends ArgSpecs> = { readonly [K in keyof A]: A[K] extends `${string}?` ? string | undefined : string };
/** A command's options as `run` gets them: a boolean is `false` when absent, a string `undefined`. */
export type OptionValues<O extends OptionSpecs> = { readonly [K in keyof O]: O[K] extends { type: "boolean" } ? boolean : string | undefined };

export interface CommandDeclaration<A extends ArgSpecs, O extends OptionSpecs> {
  /** The words that select it, the first arguments: `["node", "pair"]` for `reins node pair …`. */
  words: readonly string[];
  args: A;
  /** Long options only (`--force`); `--help` is every command's. */
  options: O;
  /** What it does, one line, for `reins help`. */
  summary: string;
  /** Resolves with the exit code. Its output's last line says what happened. Throw `UsageError` for
   * arguments that parse but make no sense; anything else thrown exits 1 with its message. */
  run(input: { args: ArgValues<A>; options: OptionValues<O> }, context: CommandContext): Promise<number>;
}

export interface Command {
  readonly words: readonly string[];
  readonly summary: string;
  /** `reins node pair <server URL> <code> [--force]`. */
  readonly usage: string;
  /** What `--help` prints: the usage line, the summary and the options. */
  readonly help: string;
  /** Runs it with the arguments after its words; resolves with its exit code. */
  invoke(argv: readonly string[], context: CommandContext): Promise<number>;
}

/** Arguments that parse but make no sense (an unusable URL): the usage line and this message, exit 2. */
export class UsageError extends Error {}

export function defineCommand<const A extends ArgSpecs, const O extends OptionSpecs>(declaration: CommandDeclaration<A, O>): Command {
  const { words, args, options, summary } = declaration;
  const required = args.filter(arg => !arg.endsWith("?"));
  if (args.slice(0, required.length).some(arg => arg.endsWith("?"))) throw new Error(`reins ${words.join(" ")}: optional arguments must come after the required ones`);
  if ("help" in options) throw new Error(`reins ${words.join(" ")}: --help is every command's own`);

  const optionEntries = Object.entries(options);
  const usage = [
    "reins", ...words,
    ...args.map(arg => arg.endsWith("?") ? `[${arg.slice(0, -1)}]` : `<${arg}>`),
    ...optionEntries.map(([name, option]) => option.type === "boolean" ? `[--${name}]` : `[--${name} <${option.value}>]`),
  ].join(" ");
  const optionNames = optionEntries.map(([name, option]) => option.type === "boolean" ? `--${name}` : `--${name} <${option.value}>`);
  const width = Math.max(0, ...optionNames.map(name => name.length));
  const help = [
    `Usage: ${usage}`,
    summary,
    ...optionEntries.length > 0 ? ["", "Options:", ...optionEntries.map(([, option], i) => `  ${optionNames[i]!.padEnd(width)}  ${option.description}`)] : [],
  ].join("\n");

  const isArgValues = (values: readonly string[]): values is ArgValues<A> => values.length >= required.length && values.length <= args.length;
  const isOptionValues = (values: Record<string, unknown>): values is OptionValues<O> =>
    optionEntries.every(([name, option]) => option.type === "boolean" ? typeof values[name] === "boolean" : values[name] === undefined || typeof values[name] === "string");

  const usageFailure = (context: CommandContext, problem: string) => {
    context.err(`Usage: ${usage}\n${problem}`);
    return EXIT_USAGE;
  };

  return {
    words,
    summary,
    usage,
    help,
    async invoke(argv, context) {
      const terminator = argv.indexOf("--");
      if ((terminator === -1 ? argv : argv.slice(0, terminator)).includes("--help")) {
        context.out(help);
        return EXIT_OK;
      }
      let parsed: { values: Record<string, unknown>; positionals: string[] };
      try {
        parsed = parseArgs({ args: [...argv], options: Object.fromEntries(optionEntries.map(([name, option]) => [name, { type: option.type }])), strict: true, allowPositionals: true });
      } catch (error) {
        return usageFailure(context, parseProblem(error));
      }
      const values = Object.fromEntries(optionEntries.map(([name, option]) => [name, option.type === "boolean" ? parsed.values[name] === true : parsed.values[name]]));
      const positionals = parsed.positionals;
      if (positionals.length < required.length) return usageFailure(context, `Missing ${required.slice(positionals.length).map(arg => `<${arg}>`).join(" ")}.`);
      if (!isArgValues(positionals)) return usageFailure(context, "Too many arguments.");
      if (!isOptionValues(values)) return usageFailure(context, "An option is missing its value or has one it does not take.");
      try {
        return await declaration.run({ args: positionals, options: values }, context);
      } catch (error) {
        if (error instanceof UsageError) return usageFailure(context, error.message);
        context.err(`reins ${words.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`);
        return EXIT_FAILED;
      }
    },
  };
}

/** What is wrong with arguments that do not parse, without parseArgs's message: it quotes them. */
function parseProblem(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return "Unknown option. An argument that starts with \"-\" goes after \"--\".";
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") return "An option is missing its value or has one it does not take.";
  return "The arguments do not parse.";
}
