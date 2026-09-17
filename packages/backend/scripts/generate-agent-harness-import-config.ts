import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface CatalogIdentity { provider: string; modelId: string }
export interface GeneratedImportConfig {
  catalog: CatalogIdentity[];
  sessions: Record<string, { model: CatalogIdentity }>;
}

function normalizeProvider(provider: string): string {
  return provider === "claude_agent_sdk" || provider === "claude-agent-sdk" ? "anthropic" : provider;
}

export function generateImportConfig(sourcePath: string, catalog: readonly CatalogIdentity[]): GeneratedImportConfig {
  const db = new Database(sourcePath, { readonly: true });
  try {
    const rows = db.query<{ id: string; model_provider: string | null; model_id: string | null }, []>(
      "SELECT id, model_provider, model_id FROM sessions ORDER BY id",
    ).all();
    const sessions: GeneratedImportConfig["sessions"] = {};
    for (const row of rows) {
      if (!row.model_provider || !row.model_id) {
        throw new Error(`Session ${row.id} has no explicit model identity; select it before import`);
      }
      sessions[row.id] = { model: { provider: normalizeProvider(row.model_provider), modelId: row.model_id } };
    }
    return {
      catalog: catalog.toSorted((a, b) => `${a.provider}\0${a.modelId}`.localeCompare(`${b.provider}\0${b.modelId}`)),
      sessions,
    };
  } finally {
    db.close();
  }
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Required option: ${name}`);
  return resolve(value);
}

if (import.meta.main) {
  const source = option("--source");
  const output = option("--output");
  if (existsSync(output)) throw new Error(`Output already exists: ${output}`);
  process.env.PI_OFFLINE = "1";
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
    authPath: resolve(dirname(output), ".empty-auth.json"),
  });
  const catalog = runtime.getModels().map((model) => ({ provider: model.provider, modelId: model.id }));
  const config = generateImportConfig(source, catalog);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ output, sessions: Object.keys(config.sessions).length, catalog: config.catalog.length }));
}
