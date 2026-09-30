/**
 * The test runner's watchdog (started by `processes.ts`, in its own session so a signal to the runner's
 * process group does not reach it). Reads `+group <pgid>`, `-group <pgid>`, `+dir <path>` and
 * `-dir <path>` lines on stdin. When stdin closes, because the runner exited however it died (SIGKILL
 * included), it SIGKILLs the process groups still listed and removes the directories still listed.
 */
import { rmSync } from "node:fs";

const groups = new Set<number>();
const dirs = new Set<string>();
const decoder = new TextDecoder();
let pending = "";
for await (const chunk of Bun.stdin.stream()) {
  pending += decoder.decode(chunk, { stream: true });
  const lines = pending.split("\n");
  pending = lines.pop()!;
  for (const line of lines) {
    const [op, value] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)];
    if (op === "+group") groups.add(Number(value));
    else if (op === "-group") groups.delete(Number(value));
    else if (op === "+dir") dirs.add(value);
    else if (op === "-dir") dirs.delete(value);
  }
}
for (const pgid of groups) {
  try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
}
if (groups.size > 0) await Bun.sleep(200); // let them die before removing the directories they write
for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
