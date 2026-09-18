import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  captureLegacyHistoryBaseline,
  validateConvertedAgentHarnessHistory,
} from "./lib/agent-harness-history-validation.js";

function option(name: string, required = true): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (required && (!value || value.startsWith("--"))) throw new Error(`Required option: ${name}`);
  return value;
}

export async function validate(sourcePath: string, outputPath: string) {
  if (realpathSync(sourcePath) === realpathSync(outputPath)) throw new Error("Source and output must differ");
  const source = new Database(sourcePath, { readonly: true });
  const output = new Database(outputPath, { readonly: true });
  try {
    const baseline = captureLegacyHistoryBaseline(source);
    return validateConvertedAgentHarnessHistory(output, baseline);
  } finally {
    source.close();
    output.close();
  }
}

if (import.meta.main) {
  const source = option("--source")!;
  const output = option("--output")!;
  const reportPath = option("--report", false);
  const report = await validate(source, output);
  if (reportPath) {
    if (existsSync(reportPath)) throw new Error(`Report already exists: ${reportPath}`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  console.log(JSON.stringify(report, null, 2));
}
