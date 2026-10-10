import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateBuild, currentBuildId, launcherPath } from "./install.js";
import { bunTarget, installUpdate } from "./update.js";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

const SERVER = "http://reins.example.test:3100";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A node home running build `old` on this Bun. */
async function installedHome() {
  const home = tempDir("reins-update-");
  symlinkSync(process.execPath, join(home, "bun"));
  writeFileSync(join(home, "old.js"), "console.log(\"old\");\n");
  const old = await activateBuild(home, join(home, "old.js"));
  return { home, old };
}

/** A build the server offers: its bytes and the `update` reply naming it, on `bunVersion`. */
function build(source: string, bunVersion = Bun.version) {
  const id = sha256(source);
  return { source, update: { buildId: id, sha256: id, bunVersion } };
}

/** A fetch answering each URL from `routes` (else 404), recording what was asked. */
function fetcher(routes: Record<string, () => Response>) {
  const urls: string[] = [];
  const fetch = async (url: string) => {
    urls.push(url);
    return routes[url]?.() ?? new Response("Not found", { status: 404 });
  };
  return { urls, fetch };
}

test("an update downloads the build from the server, checks it, makes it current and writes the launcher; on the same Bun it fetches no Bun", async () => {
  const { home } = await installedHome();
  const next = build("console.log(\"next\");\n");
  const server = fetcher({ [`${SERVER}/nodes/builds/${next.update.buildId}/reins.js`]: () => new Response(next.source) });

  await installUpdate(home, SERVER, next.update, { fetch: server.fetch });

  expect(server.urls).toEqual([`${SERVER}/nodes/builds/${next.update.buildId}/reins.js`]);
  expect({ current: await currentBuildId(home), bundle: readFileSync(join(home, "current", "reins.js"), "utf8"), launcher: existsSync(launcherPath(home)) })
    .toEqual({ current: next.update.buildId, bundle: next.source, launcher: true });
  expect(readdirSync(join(home, "builds", next.update.buildId))).toEqual(["reins.js"]);
});

test("a download that fails, or does not match its checksum, leaves the current build as it was and nothing beside it", async () => {
  const { home, old } = await installedHome();
  const next = build("console.log(\"next\");\n");
  const url = `${SERVER}/nodes/builds/${next.update.buildId}/reins.js`;

  await expect(installUpdate(home, SERVER, next.update, { fetch: fetcher({ [url]: () => new Response("Building", { status: 503 }) }).fetch }))
    .rejects.toThrow(`could not download build ${next.update.buildId.slice(0, 12)} from ${SERVER}: HTTP 503`);
  await expect(installUpdate(home, SERVER, next.update, { fetch: fetcher({ [url]: () => new Response("console.log(\"tampered\");\n") }).fetch }))
    .rejects.toThrow(`build ${next.update.buildId.slice(0, 12)} from ${SERVER} does not match its checksum`);

  expect(await currentBuildId(home)).toBe(old);
  expect(existsSync(join(home, "builds", next.update.buildId)) ? readdirSync(join(home, "builds", next.update.buildId)) : []).toEqual([]);
});

test("a build on another Bun fetches that Bun's official release for this machine and installs it as the home's bun before making the build current", async () => {
  const { home } = await installedHome();
  const next = build("console.log(\"next\");\n", "1.9.0");
  const release = "https://github.com/oven-sh/bun/releases/download/bun-v1.9.0/bun-linux-x64-baseline.zip";
  const server = fetcher({
    [`${SERVER}/nodes/builds/${next.update.buildId}/reins.js`]: () => new Response(next.source),
    [release]: () => new Response("the zip"),
  });
  const unpacked: Array<{ zip: string; entry: string }> = [];

  await installUpdate(home, SERVER, next.update, {
    fetch: server.fetch,
    machine: { platform: "linux", arch: "x64", musl: false, avx2: false, rosetta: false },
    // Stands in for unzip: the release's bun is a script that says its version.
    async unpack(zip, entry, dir) {
      unpacked.push({ zip: readFileSync(zip, "utf8"), entry });
      writeFileSync(join(dir, "bun"), "#!/bin/sh\necho 1.9.0\n");
    },
  });

  expect(server.urls).toEqual([`${SERVER}/nodes/builds/${next.update.buildId}/reins.js`, release]);
  expect(unpacked).toEqual([{ zip: "the zip", entry: "bun-linux-x64-baseline/bun" }]);
  expect(Bun.spawnSync([join(home, "bun"), "--version"]).stdout.toString()).toBe("1.9.0\n");
  expect(await currentBuildId(home)).toBe(next.update.buildId);
  // Its temporary directory is gone.
  expect(readdirSync(home).toSorted()).toEqual(["bin", "builds", "bun", "current", "old.js"]);
});

test("a Bun that cannot be fetched, or does not run as its version, leaves the home's bun and current build as they were", async () => {
  const { home, old } = await installedHome();
  const next = build("console.log(\"next\");\n", "1.9.0");
  const bundle = { [`${SERVER}/nodes/builds/${next.update.buildId}/reins.js`]: () => new Response(next.source) };
  const machine = { platform: "darwin", arch: "arm64", musl: false, avx2: false, rosetta: false } as const;
  const release = "https://github.com/oven-sh/bun/releases/download/bun-v1.9.0/bun-darwin-aarch64.zip";

  await expect(installUpdate(home, SERVER, next.update, { fetch: fetcher(bundle).fetch, machine }))
    .rejects.toThrow("could not download Bun 1.9.0 for darwin-aarch64 from GitHub: HTTP 404");
  await expect(installUpdate(home, SERVER, next.update, {
    fetch: fetcher({ ...bundle, [release]: () => new Response("the zip") }).fetch, machine,
    async unpack(_zip, _entry, dir) { writeFileSync(join(dir, "bun"), "#!/bin/sh\necho 1.2.0\n"); },
  })).rejects.toThrow("Bun 1.9.0 for darwin-aarch64 does not run on this machine");

  expect({ bun: realpathSync(join(home, "bun")), current: await currentBuildId(home) }).toEqual({ bun: realpathSync(process.execPath), current: old });
  expect(readdirSync(home).toSorted()).toEqual(["builds", "bun", "current", "old.js"]);
});

test("Bun's release for a machine is the one its own installer picks", () => {
  const machine = { platform: "linux", arch: "x64", musl: false, avx2: true, rosetta: false } as const;
  expect(bunTarget(machine)).toBe("linux-x64");
  // Bun's default x64 build needs AVX2.
  expect(bunTarget({ ...machine, avx2: false })).toBe("linux-x64-baseline");
  expect(bunTarget({ ...machine, musl: true, avx2: false })).toBe("linux-x64-musl-baseline");
  expect(bunTarget({ ...machine, arch: "arm64", musl: true })).toBe("linux-aarch64-musl");
  expect(bunTarget({ ...machine, platform: "darwin" })).toBe("darwin-x64");
  // A Bun under Rosetta on Apple silicon: the native build.
  expect(bunTarget({ ...machine, platform: "darwin", rosetta: true })).toBe("darwin-aarch64");
  expect(() => bunTarget({ ...machine, platform: "win32" })).toThrow("Reins nodes run on Linux and macOS, not win32");
});
