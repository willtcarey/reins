/**
 * Telling a process apart from another that later got its pid: private to NodeInstall (install.ts), which
 * trusts, or signals, a recorded pid only while its start time is still the recorded one.
 */
import { readFileSync } from "node:fs";

/**
 * When process `pid` started, as an opaque string, or null when no such process is running (a zombie
 * counts as gone). Linux: `/proc/<pid>/stat`'s start time (clock ticks since boot); elsewhere (macOS):
 * `ps -o lstart=`.
 */
export function processStartTime(pid: number): string | null {
  let stat: string | undefined;
  try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { /* not Linux, or no such process */ }
  if (stat !== undefined) {
    // After the command name (in parentheses, which may hold anything): the state, then fields 4 on;
    // the start time is field 22.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[0] === "X" ? null : fields[19] ?? null;
  }
  if (process.platform === "linux") return null;
  const ps = Bun.spawnSync(["ps", "-o", "stat=,lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const line = ps.stdout.toString().trim();
  if (ps.exitCode !== 0 || line === "" || line.startsWith("Z")) return null;
  return line.slice(line.indexOf(" ") + 1).trim();
}
