/**
 * The libraries the app provides to added extensions' frontend parts (docs/dev/extension-loading.md
 * *Provided libraries*): each public module of Lit, built as ES modules into `dist/vendor/lit/` with their
 * shared code split into chunks, so every extension that imports `lit` and `lit/decorators.js` gets one Lit;
 * and `@reins/ui` into `dist/vendor/reins-ui/`, on that Lit. index.html's import map points `lit`, `lit/` and
 * `@reins/ui` there. Extensions build with these left external.
 *
 * Run by the frontend's build (`bun src/vendor/build.ts`) and by the dev supervisor before its watchers; in dev,
 * `--watch-kit` builds the kit again when `packages/ui` changes (the supervisor's `frontend:kit`).
 */
import { readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";

const FRONTEND = join(import.meta.dir, "../..");

/** Builds the provided libraries into `outdir` (`dist/vendor` by default). Throws with the build's logs. */
export async function buildVendor(outdir = join(FRONTEND, "dist/vendor")): Promise<void> {
  await Promise.all([buildLit(outdir), buildUi(outdir)]);
}

async function buildLit(outdir: string) {
  const root = dirname(Bun.resolveSync("lit/package.json", FRONTEND));
  const exports: Record<string, unknown> = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).exports;
  const entrypoints = Object.keys(exports)
    .filter(key => key !== "./polyfill-support.js")
    .map(key => join(root, key === "." ? "index.js" : key));
  const result = await Bun.build({
    entrypoints,
    root,
    outdir: join(outdir, "lit"),
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    naming: { entry: "[dir]/[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
    throw: false,
  });
  check(result);
}

/** Where the kit's code is, and its entry. */
type KitSource = { dir: string; entry: string };

function kitSource(): KitSource {
  const entry = Bun.resolveSync("@reins/ui", FRONTEND);
  return { dir: dirname(dirname(entry)), entry };
}

async function buildUi(outdir: string, entry = kitSource().entry) {
  check(await Bun.build({
    entrypoints: [entry],
    outdir: join(outdir, "reins-ui"),
    target: "browser",
    format: "esm",
    minify: true,
    external: ["lit", "lit/*"],
    naming: { entry: "index.[ext]" },
    throw: false,
  }));
}

function check(result: Bun.BuildOutput) {
  if (!result.success) throw new Error(`Building the provided libraries failed:\n${result.logs.join("\n")}`);
}

/** Builds the kit into `outdir` again after each change of a file of its package, one build at a time; a failed build
 * is reported and the watch goes on. Returns the stop. */
export function watchKit(outdir: string, source = kitSource(), log = (message: string) => console.error(message)): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let building: Promise<void> | null = null;
  let again = false;
  const build = async () => {
    if (building) {
      again = true;
      return;
    }
    building = buildUi(outdir, source.entry).then(
      () => log("[vendor] @reins/ui built: reload the page"),
      (error: unknown) => log(error instanceof Error ? error.message : String(error)),
    );
    await building;
    building = null;
    if (again) {
      again = false;
      await build();
    }
  };
  const watcher = watch(source.dir, { recursive: true }, (_event, file) => {
    if (file?.split(/[\\/]/).includes("node_modules")) return;
    if (timer) clearTimeout(timer);
    // An editor's save is often several writes.
    timer = setTimeout(() => { timer = null; void build(); }, 50);
  });
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}

if (import.meta.main) {
  if (process.argv.includes("--watch-kit")) watchKit(join(FRONTEND, "dist/vendor"));
  else await buildVendor();
}
