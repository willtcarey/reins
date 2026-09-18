import { readFile } from "node:fs/promises";
import { importAgentHarnessHistory, type ImportConfig } from "./lib/agent-harness-history-import.js";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Required option: ${name}`);
  return value;
}

const source = option("--source");
const output = option("--output");
const configPath = option("--config");
const reportIndex = process.argv.indexOf("--report");
const report = reportIndex < 0 ? undefined : option("--report");
const config: ImportConfig = JSON.parse(await readFile(configPath, "utf8"));
const result = await importAgentHarnessHistory({ source, output, config, ...(report ? { report } : {}) });
console.log(JSON.stringify(result, null, 2));
