export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

type ConsoleMethod = "error" | "warn" | "log" | "debug";

const LOG_LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  switch (value.trim().toLowerCase()) {
    case "silent": return "silent";
    case "error": return "error";
    case "warn": return "warn";
    case "info": return "info";
    case "debug": return "debug";
    default: return undefined;
  }
}

export function logLevelForEnv(env: Record<string, string | undefined> = process.env): LogLevel {
  if (env.NODE_ENV === "test") return "warn";
  return parseLogLevel(env.REINS_LOG_LEVEL) ?? "info";
}

function shouldLog(level: Exclude<LogLevel, "silent">): boolean {
  return LOG_LEVELS[logLevelForEnv()] >= LOG_LEVELS[level];
}

function write(level: Exclude<LogLevel, "silent">, method: ConsoleMethod, args: unknown[]): void {
  if (!shouldLog(level)) return;
  console[method](...args);
}

export const logger = {
  debug: (...args: unknown[]) => write("debug", "debug", args),
  info: (...args: unknown[]) => write("info", "log", args),
  warn: (...args: unknown[]) => write("warn", "warn", args),
  error: (...args: unknown[]) => write("error", "error", args),
};
