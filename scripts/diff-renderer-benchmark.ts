#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync, renameSync, unlinkSync, readFileSync } from "fs";
import { join, resolve } from "path";
import {
  parseBenchmarkArgs,
  summarizeSamples,
  summarizeTraceEvents,
  type BenchmarkConfig,
  type BenchmarkFixture,
  type BenchmarkProfile,
  type BenchmarkRenderer,
  type MainThreadIdentity,
  type TraceEvent,
} from "./diff-renderer-benchmark-lib.js";

interface FixtureRecord {
  id: BenchmarkFixture;
  projectId: number;
  sessionId: string;
  repoPath: string;
  expectedFiles: number;
  description: string;
}

interface ApiMeasurement {
  path: string;
  durationMs: number;
  transferBytes: number;
  decodedBytes: number | null;
}

interface RunResult {
  renderer: BenchmarkRenderer;
  fixture: BenchmarkFixture;
  profile: string;
  repetition: number;
  cache: "cold" | "warm";
  firstVisibleMs: number;
  instrumentation: Record<string, number | null>;
  api: ApiMeasurement[];
  mountedFileWrappers: number;
  domNodes: number;
  heap: { beforeBytes: number; firstVisibleBytes: number; growthBytes: number };
  loadTrace: ReturnType<typeof summarizeTraceEvents>;
  scroll: Record<string, number>;
  scrollTrace: ReturnType<typeof summarizeTraceEvents>;
  contextExpansionMs: number | null;
  idle: Record<string, number>;
  idleTrace: ReturnType<typeof summarizeTraceEvents>;
}

class CdpClient {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private listeners = new Map<string, Set<(params: any) => void>>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveReady, reject) => {
      socket.addEventListener("open", () => resolveReady(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Unable to connect to ${url}`)), { once: true });
    });
    return new CdpClient(socket);
  }

  command(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolveCommand, reject) => {
      this.pending.set(id, { resolve: resolveCommand, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: any) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  event(method: string, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolveEvent, reject) => {
      const cleanup = this.on(method, (params) => {
        clearTimeout(timer);
        cleanup();
        resolveEvent(params);
      });
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
    });
  }

  close(): void {
    this.socket.close();
  }
}

const config = parseBenchmarkArgs(process.argv.slice(2));
const root = resolve("tmp/diff-renderer-benchmark");
const dataDir = join(root, "data");
const chromeDataDir = join(root, "chrome");
const port = 3310;
const chromePort = 9331;

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const fixtureSpecs = createFixtures(root);
process.env.REINS_DATA_DIR = dataDir;
const { createProject } = await import("../packages/backend/src/project-store.js");
const { createSession } = await import("../packages/backend/src/session-store.js");
const fixtures: FixtureRecord[] = fixtureSpecs.map((fixture, index) => {
  const project = createProject(`Diff benchmark: ${fixture.id}`, fixture.repoPath, "main");
  const sessionId = `diff-benchmark-${index + 1}`;
  createSession(sessionId, project.id, { agentRuntimeType: "pi" });
  return { ...fixture, projectId: project.id, sessionId };
});

if (config.build) buildDevelopmentFrontend();
const server = Bun.spawn({
  cmd: ["bun", "packages/backend/src/index.ts"],
  env: { ...process.env, REINS_DATA_DIR: dataDir, REINS_PORT: String(port), REINS_DEV: "1" },
  stdout: "inherit",
  stderr: "inherit",
});
let chrome: ReturnType<typeof Bun.spawn> | null = null;

try {
  await waitForHttp(`http://127.0.0.1:${port}/api/health`, 30_000);
  chrome = Bun.spawn({
    cmd: [
      "google-chrome",
      "--headless=new",
      `--remote-debugging-port=${chromePort}`,
      `--user-data-dir=${chromeDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--enable-precise-memory-info",
      "--js-flags=--expose-gc",
      "about:blank",
    ],
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForHttp(`http://127.0.0.1:${chromePort}/json/version`, 30_000);

  const runs: RunResult[] = [];
  for (const profile of config.profiles) {
    for (const fixtureName of config.fixtures) {
      const fixture = fixtures.find((candidate) => candidate.id === fixtureName)!;
      for (const renderer of config.renderers) {
        await setRenderer(port, renderer);
        for (let repetition = 1; repetition <= config.repetitions; repetition++) {
          const cache = repetition === 1 ? "cold" : "warm";
          process.stderr.write(`[benchmark] ${profile.id} ${fixture.id} ${renderer} ${repetition}/${config.repetitions} (${cache})\n`);
          runs.push(await runScenario(port, chromePort, renderer, fixture, profile, repetition, cache, config.idleMs));
          mkdirSync(resolve(config.outputPath, ".."), { recursive: true });
          writeFileSync(`${config.outputPath}.partial`, `${JSON.stringify(runs, null, 2)}\n`);
        }
      }
    }
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: environmentMetadata(config),
    fixtures: fixtures.map(({ projectId: _projectId, sessionId: _sessionId, ...fixture }) => fixture),
    methodology: {
      repetitions: config.repetitions,
      coldDefinition: "The first repetition clears Chromium's browser cache; subsequent repetitions retain it. Every repetition uses a fresh page.",
      firstVisibleDefinition: "Navigation start to the first intersecting rendered diff row/file surface after selecting Changes.",
      idleIntervalMs: config.idleMs,
      controlledScrollFrames: 120,
      cpuThrottling: "Chrome DevTools Protocol Emulation.setCPUThrottlingRate; rate 4 means a 4x CPU slowdown.",
    },
    runs,
    aggregates: aggregateRuns(runs),
  };
  mkdirSync(resolve(config.outputPath, ".."), { recursive: true });
  writeFileSync(config.outputPath, `${JSON.stringify(output, null, 2)}\n`);
  rmSync(`${config.outputPath}.partial`, { force: true });
  process.stdout.write(`${JSON.stringify({ output: config.outputPath, runs: runs.length, aggregates: output.aggregates }, null, 2)}\n`);
} finally {
  chrome?.kill("SIGTERM");
  server.kill("SIGTERM");
}

function run(command: string[], cwd?: string): void {
  const result = Bun.spawnSync({ cmd: command, cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}`);
}

function buildDevelopmentFrontend(): void {
  run([
    "bun", "build",
    "src/index.ts",
    "src/models/changes/highlight-worker.ts",
    "src/models/changes/pierre-diffs-worker.ts",
    "--outdir", "dist",
    "--splitting",
    "--define", "REINS_DEV=true",
  ], "packages/frontend");
  run(["bunx", "@tailwindcss/cli", "-i", "src/components/app.css", "-o", "dist/app.css", "--minify"], "packages/frontend");
}

function createFixtures(parent: string): Array<Omit<FixtureRecord, "projectId" | "sessionId">> {
  return [createSmallFixture(parent), createManyFilesFixture(parent), createLargeFileFixture(parent)];
}

function initializeRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  run(["git", "init", "-b", "main"], path);
  run(["git", "config", "user.email", "benchmark@reins.local"], path);
  run(["git", "config", "user.name", "Reins Benchmark"], path);
}

function commit(path: string, message: string): void {
  run(["git", "add", "-A"], path);
  run(["git", "commit", "-m", message, "--quiet"], path);
}

function numberedLines(count: number, prefix: string): string {
  return Array.from({ length: count }, (_, index) => `${prefix} line ${String(index + 1).padStart(6, "0")}`).join("\n") + "\n";
}

function createSmallFixture(parent: string): Omit<FixtureRecord, "projectId" | "sessionId"> {
  const repoPath = join(parent, "fixture-small");
  initializeRepo(repoPath);
  mkdirSync(join(repoPath, "src"), { recursive: true });
  writeFileSync(join(repoPath, "src/app.ts"), numberedLines(180, "export const value ="));
  writeFileSync(join(repoPath, "src/rename-me.ts"), numberedLines(40, "rename"));
  writeFileSync(join(repoPath, "src/delete-me.ts"), numberedLines(30, "delete"));
  writeFileSync(join(repoPath, "README.md"), numberedLines(50, "readme"));
  commit(repoPath, "base");
  run(["git", "checkout", "-b", "benchmark", "--quiet"], repoPath);
  const app = readFileSync(join(repoPath, "src/app.ts"), "utf8").replace("export const value = line 000090", "export const value = changed 000090");
  writeFileSync(join(repoPath, "src/app.ts"), app);
  renameSync(join(repoPath, "src/rename-me.ts"), join(repoPath, "src/renamed.ts"));
  unlinkSync(join(repoPath, "src/delete-me.ts"));
  writeFileSync(join(repoPath, "src/new-file.ts"), numberedLines(45, "new"));
  writeFileSync(join(repoPath, "README.md"), readFileSync(join(repoPath, "README.md"), "utf8") + "benchmark note\n");
  commit(repoPath, "representative small mixed diff");
  return { id: "small", repoPath, expectedFiles: 5, description: "Five-file normal diff with modify, add, delete, and rename statuses." };
}

function createManyFilesFixture(parent: string): Omit<FixtureRecord, "projectId" | "sessionId"> {
  const repoPath = join(parent, "fixture-many-files");
  initializeRepo(repoPath);
  mkdirSync(join(repoPath, "src"), { recursive: true });
  for (let index = 0; index < 300; index++) {
    writeFileSync(join(repoPath, "src", `file-${String(index).padStart(3, "0")}.ts`), numberedLines(35, `file ${index}`));
  }
  commit(repoPath, "base");
  run(["git", "checkout", "-b", "benchmark", "--quiet"], repoPath);
  for (let index = 0; index < 280; index++) {
    const path = join(repoPath, "src", `file-${String(index).padStart(3, "0")}.ts`);
    writeFileSync(path, readFileSync(path, "utf8").replace("line 000018", "changed 000018"));
  }
  for (let index = 280; index < 290; index++) unlinkSync(join(repoPath, "src", `file-${index}.ts`));
  for (let index = 0; index < 10; index++) writeFileSync(join(repoPath, "src", `new-${index}.ts`), numberedLines(25, `new ${index}`));
  commit(repoPath, "many small files");
  return { id: "many-files", repoPath, expectedFiles: 300, description: "Three hundred small changed files, including ten additions and ten deletions." };
}

function createLargeFileFixture(parent: string): Omit<FixtureRecord, "projectId" | "sessionId"> {
  const repoPath = join(parent, "fixture-large-file");
  initializeRepo(repoPath);
  writeFileSync(join(repoPath, "large.ts"), numberedLines(25_000, "const large ="));
  commit(repoPath, "base");
  run(["git", "checkout", "-b", "benchmark", "--quiet"], repoPath);
  const lines = readFileSync(join(repoPath, "large.ts"), "utf8").split("\n");
  for (let index = 99; index < 25_000; index += 100) lines[index] = `${lines[index]} changed`;
  writeFileSync(join(repoPath, "large.ts"), lines.join("\n"));
  commit(repoPath, "one large file");
  return { id: "large-file", repoPath, expectedFiles: 1, description: "One 25,000-line file with 250 separated changed regions." };
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function setRenderer(portNumber: number, renderer: BenchmarkRenderer): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${portNumber}/api/settings/diff_renderer`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(renderer),
  });
  if (!response.ok) throw new Error(`Unable to select renderer ${renderer}: HTTP ${response.status}`);
}

async function runScenario(
  serverPort: number,
  remoteDebuggingPort: number,
  renderer: BenchmarkRenderer,
  fixture: FixtureRecord,
  profile: BenchmarkProfile,
  repetition: number,
  cache: "cold" | "warm",
  idleMs: number,
): Promise<RunResult> {
  const target = await (await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/new?about:blank`, { method: "PUT" })).json();
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  const network = new Map<string, any>();
  const completedApi: ApiMeasurement[] = [];
  client.on("Network.requestWillBeSent", (event) => {
    const url = new URL(event.request.url);
    if (!url.pathname.includes("/diff")) return;
    network.set(event.requestId, { path: url.pathname, start: event.timestamp });
  });
  client.on("Network.responseReceived", (event) => {
    const entry = network.get(event.requestId);
    if (entry) entry.response = event.response;
  });
  client.on("Network.loadingFinished", async (event) => {
    const entry = network.get(event.requestId);
    if (!entry) return;
    let decodedBytes: number | null = null;
    try {
      const body = await client.command("Network.getResponseBody", { requestId: event.requestId });
      decodedBytes = body.base64Encoded
        ? Buffer.from(body.body, "base64").byteLength
        : Buffer.byteLength(body.body);
    } catch {}
    completedApi.push({
      path: entry.path,
      durationMs: round((event.timestamp - entry.start) * 1000),
      transferBytes: Math.round(event.encodedDataLength),
      decodedBytes,
    });
  });

  try {
    await Promise.all([
      client.command("Page.enable"),
      client.command("Network.enable"),
      client.command("Performance.enable"),
      client.command("Runtime.enable"),
    ]);
    await client.command("Emulation.setDeviceMetricsOverride", {
      width: profile.viewport.width,
      height: profile.viewport.height,
      deviceScaleFactor: profile.viewport.deviceScaleFactor,
      mobile: profile.viewport.mobile,
      screenWidth: profile.viewport.width,
      screenHeight: profile.viewport.height,
    });
    await client.command("Emulation.setCPUThrottlingRate", { rate: profile.cpuThrottlingRate });
    if (cache === "cold") await client.command("Network.clearBrowserCache");
    await client.command("Network.setCacheDisabled", { cacheDisabled: false });
    await evaluate(client, "globalThis.gc?.(); true");
    const heapBefore = Number((await client.command("Runtime.getHeapUsage")).usedSize);

    await startTrace(client);
    await client.command("Page.navigate", { url: `http://127.0.0.1:${serverPort}/#/session/${fixture.sessionId}` });
    await waitForExpression(
      client,
      "document.querySelector('diff-renderer-shell')?.store?.projectId != null",
      30_000,
    );
    await evaluate(client, `(() => {
      const buttons = [...document.querySelectorAll('app-main-toolbar button')];
      const button = buttons.find((candidate) => candidate.textContent?.trim() === 'Changes');
      if (!button) throw new Error('Changes button not found');
      button.click();
      const shell = document.querySelector('diff-renderer-shell');
      const store = shell?.store;
      if (store && '${renderer}' === 'classic' && !store.fullData.data && !store.fullData.loading) {
        void store.fetchFullDiff();
      }
      return true;
    })()`);
    const firstVisible = await evaluate(client, `new Promise((resolve) => {
      const deadline = performance.now() + 30000;
      const visit = (root, output = []) => {
        for (const element of root.querySelectorAll('*')) {
          output.push(element);
          if (element.shadowRoot) visit(element.shadowRoot, output);
        }
        return output;
      };
      const check = () => {
        const shell = document.querySelector('[data-diff-renderer="${renderer}"]');
        const candidates = visit(shell ?? document).filter((element) =>
          element.matches?.('diff-file-card, review-file-diff, [data-line-type], [data-file]')
        );
        const visible = candidates.some((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
        });
        if (visible) return requestAnimationFrame(() => resolve({ value: performance.now() }));
        if (performance.now() > deadline) return resolve({
          value: null,
          diagnostic: {
            shell: shell?.outerHTML.slice(0, 2000) ?? null,
            candidateCount: candidates.length,
            bodyText: document.body.innerText.slice(0, 1000),
          },
        });
        requestAnimationFrame(check);
      };
      check();
    })`, true);
    if (firstVisible.value == null) {
      throw new Error(`Timed out waiting for first visible diff: ${JSON.stringify(firstVisible.diagnostic)}`);
    }
    const firstVisibleMs = Number(firstVisible.value);
    const heapFirst = Number((await client.command("Runtime.getHeapUsage")).usedSize);
    const snapshot = await collectDomSnapshot(client, renderer);
    const instrumentation = await collectInstrumentation(client, renderer);
    const loadTrace = summarizeCapturedTrace(await stopTrace(client));

    await startTrace(client);
    const idleBefore = metricsMap(await client.command("Performance.getMetrics"));
    await Bun.sleep(idleMs);
    const idleAfter = metricsMap(await client.command("Performance.getMetrics"));
    const idleTrace = summarizeCapturedTrace(await stopTrace(client));
    const idle = metricDelta(idleBefore, idleAfter, [
      "TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "JSHeapUsedSize", "Nodes",
    ]);

    await startTrace(client);
    const scroll = await controlledScroll(client);
    const scrollTrace = summarizeCapturedTrace(await stopTrace(client));

    let contextExpansionMs: number | null = null;
    if (renderer === "virtualized") contextExpansionMs = await expandContext(client);

    return {
      renderer,
      fixture: fixture.id,
      profile: profile.id,
      repetition,
      cache,
      firstVisibleMs: round(firstVisibleMs),
      instrumentation,
      api: completedApi.toSorted((left, right) => left.path.localeCompare(right.path)),
      mountedFileWrappers: snapshot.mountedFileWrappers,
      domNodes: snapshot.domNodes,
      heap: { beforeBytes: heapBefore, firstVisibleBytes: heapFirst, growthBytes: heapFirst - heapBefore },
      loadTrace,
      scroll,
      scrollTrace,
      contextExpansionMs,
      idle,
      idleTrace,
    };
  } finally {
    client.close();
    await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/close/${target.id}`);
  }
}

async function evaluate(client: CdpClient, expression: string, awaitPromise = false): Promise<any> {
  const result = await client.command("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Runtime evaluation failed");
  return result.result.value;
}

async function waitForExpression(client: CdpClient, expression: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, expression)) return;
    } catch {}
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for browser expression: ${expression}`);
}

async function collectDomSnapshot(client: CdpClient, renderer: BenchmarkRenderer) {
  return evaluate(client, `(() => {
    const shell = document.querySelector('[data-diff-renderer="${renderer}"]');
    const visit = (root) => {
      let count = 0;
      for (const element of root.querySelectorAll('*')) {
        count += 1;
        if (element.shadowRoot) count += visit(element.shadowRoot);
      }
      return count;
    };
    const mountedFileWrappers = ${renderer === "classic"
      ? "shell?.querySelectorAll('diff-file-card').length ?? 0"
      : renderer === "virtualized"
        ? "shell?.querySelectorAll('review-file-diff').length ?? 0"
        : `(() => {
            const root = shell?.querySelector('[data-pierre-code-view]');
            if (!root) return 0;
            const all = [];
            const collect = (node) => {
              for (const element of node.querySelectorAll('*')) {
                all.push(element);
                if (element.shadowRoot) collect(element.shadowRoot);
              }
            };
            collect(root);
            return all.filter((element) => element.matches?.('diffs-container, [data-file]')).length;
          })()`};
    return { mountedFileWrappers, domNodes: visit(document) };
  })()`);
}

async function collectInstrumentation(client: CdpClient, renderer: BenchmarkRenderer): Promise<Record<string, number | null>> {
  return evaluate(client, `(() => {
    const entries = performance.getEntriesByType('measure').filter((entry) => entry.name.startsWith('reins-diff:${renderer}:'));
    const latest = (phase) => entries.filter((entry) => entry.name.includes(':' + phase + ':')).at(-1)?.duration ?? null;
    return { payloadDecodeMs: latest('payload-decode'), parseMs: latest('parse'), renderMs: latest('render') };
  })()`);
}

async function controlledScroll(client: CdpClient): Promise<Record<string, number>> {
  const result = await evaluate(client, `new Promise((resolve) => {
    const scroll = document.querySelector('[data-diff-scroll-surface]');
    if (!scroll) return resolve({ frames: 0, durationMs: 0, p95FrameMs: 0, framesOver25Ms: 0, framesOver50Ms: 0, maxFrameMs: 0 });
    scroll.scrollTop = 0;
    const samples = [];
    const frames = 120;
    let previous = performance.now();
    let index = 0;
    const start = previous;
    const step = (now) => {
      samples.push(now - previous);
      previous = now;
      const progress = index / (frames - 1);
      scroll.scrollTop = (progress < 0.5 ? progress * 2 : (1 - progress) * 2) * Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      index += 1;
      if (index < frames) return requestAnimationFrame(step);
      samples.sort((a, b) => a - b);
      resolve({
        frames,
        durationMs: performance.now() - start,
        p95FrameMs: samples[Math.floor(samples.length * 0.95)] ?? 0,
        framesOver25Ms: samples.filter((sample) => sample > 25).length,
        framesOver50Ms: samples.filter((sample) => sample > 50).length,
        maxFrameMs: samples.at(-1) ?? 0,
      });
    };
    requestAnimationFrame(step);
  })`, true);
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, round(Number(value))]));
}

async function expandContext(client: CdpClient): Promise<number | null> {
  return evaluate(client, `new Promise((resolve) => {
    const find = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.matches?.('[data-reins-acquire-hunk-index][data-expand-button]')) return element;
        if (element.shadowRoot) {
          const match = find(element.shadowRoot);
          if (match) return match;
        }
      }
      return null;
    };
    const control = find(document);
    if (!control) return resolve(null);
    const item = control.getRootNode().host?.closest?.('review-file-diff');
    const initialHeight = item?.getBoundingClientRect().height ?? 0;
    const start = performance.now();
    control.click();
    let changed = false;
    let stableFrames = 0;
    let previousHeight = initialHeight;
    const check = () => {
      const height = item?.getBoundingClientRect().height ?? previousHeight;
      if (Math.abs(height - initialHeight) > 1) changed = true;
      stableFrames = Math.abs(height - previousHeight) < 0.5 ? stableFrames + 1 : 0;
      previousHeight = height;
      if (changed && stableFrames >= 8) return resolve(performance.now() - start);
      if (performance.now() - start > 15000) return resolve(null);
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  })`, true).then((value) => value == null ? null : round(value));
}

async function startTrace(client: CdpClient): Promise<void> {
  await client.command("Tracing.start", {
    categories: "devtools.timeline,toplevel,blink.user_timing",
    options: "sampling-frequency=10000",
    transferMode: "ReturnAsStream",
  });
}

async function stopTrace(client: CdpClient): Promise<TraceEvent[]> {
  const complete = client.event("Tracing.tracingComplete", 30_000);
  await client.command("Tracing.end");
  const { stream } = await complete;
  let json = "";
  while (true) {
    const chunk = await client.command("IO.read", { handle: stream });
    json += chunk.data;
    if (chunk.eof) break;
  }
  await client.command("IO.close", { handle: stream });
  return JSON.parse(json).traceEvents;
}

function summarizeCapturedTrace(events: TraceEvent[]) {
  const taskTimeByThread = new Map<string, { identity: MainThreadIdentity; duration: number }>();
  for (const event of events) {
    if (!["RunTask", "ThreadControllerImpl::RunTask"].includes(event.name) || event.ph !== "X" || event.dur === undefined) continue;
    const key = `${event.pid}:${event.tid}`;
    const entry = taskTimeByThread.get(key) ?? {
      identity: { pid: event.pid, tid: event.tid },
      duration: 0,
    };
    entry.duration += event.dur;
    taskTimeByThread.set(key, entry);
  }
  const busiestTaskThread = [...taskTimeByThread.values()].toSorted((left, right) => right.duration - left.duration)[0];
  const metadata = events.find((event) => (
    event.ph === "M" && event.name === "thread_name" && event.args?.name === "CrRendererMain"
  ));
  const mainThread: MainThreadIdentity = busiestTaskThread?.identity
    ?? (metadata ? { pid: metadata.pid, tid: metadata.tid } : { pid: events[0]?.pid ?? 0, tid: events[0]?.tid ?? 0 });
  return summarizeTraceEvents(events, mainThread);
}

function metricsMap(result: any): Map<string, number> {
  return new Map(result.metrics.map((metric: any) => [metric.name, metric.value]));
}

function metricDelta(before: Map<string, number>, after: Map<string, number>, names: string[]): Record<string, number> {
  return Object.fromEntries(names.map((name) => [name, round((after.get(name) ?? 0) - (before.get(name) ?? 0))]));
}

function aggregateRuns(runs: RunResult[]) {
  const groups = new Map<string, RunResult[]>();
  for (const runResult of runs) {
    const key = `${runResult.profile}/${runResult.fixture}/${runResult.renderer}`;
    const group = groups.get(key) ?? [];
    group.push(runResult);
    groups.set(key, group);
  }

  return Object.fromEntries([...groups].map(([key, group]) => {
    const warm = group.filter((runResult) => runResult.cache === "warm");
    const summarize = (values: Array<number | null | undefined>) => summarizeSamples(values.filter((value): value is number => typeof value === "number"));
    return [key, {
      coldFirstVisibleMs: group.find((runResult) => runResult.cache === "cold")?.firstVisibleMs ?? null,
      warmFirstVisibleMs: summarize(warm.map((runResult) => runResult.firstVisibleMs)),
      apiPayloadMs: summarize(group.flatMap((runResult) => runResult.api.filter((entry) => entry.path.endsWith(runResult.renderer === "classic" ? "/diff" : "/diff/patch")).map((entry) => entry.durationMs))),
      parseMs: summarize(group.map((runResult) => runResult.instrumentation.parseMs)),
      renderMs: summarize(group.map((runResult) => runResult.instrumentation.renderMs)),
      mountedFileWrappers: summarize(group.map((runResult) => runResult.mountedFileWrappers)),
      domNodes: summarize(group.map((runResult) => runResult.domNodes)),
      heapGrowthBytes: summarize(group.map((runResult) => runResult.heap.growthBytes)),
      loadLongTasks: summarize(group.map((runResult) => runResult.loadTrace.longTaskCount)),
      scrollP95FrameMs: summarize(group.map((runResult) => runResult.scroll.p95FrameMs)),
      scrollFramesOver50Ms: summarize(group.map((runResult) => runResult.scroll.framesOver50Ms)),
      contextExpansionMs: summarize(group.map((runResult) => runResult.contextExpansionMs)),
      idleTaskMs: summarize(group.map((runResult) => runResult.idleTrace.mainThreadTaskMs)),
    }];
  }));
}

function environmentMetadata(benchmarkConfig: BenchmarkConfig) {
  const chromeVersion = Bun.spawnSync(["google-chrome", "--version"]).stdout.toString().trim();
  const cpu = readFileSync("/proc/cpuinfo", "utf8").match(/^model name\s*:\s*(.+)$/m)?.[1] ?? "unknown";
  return {
    os: `${process.platform} ${process.arch}`,
    kernel: Bun.spawnSync(["uname", "-r"]).stdout.toString().trim(),
    cpu,
    logicalCpuCount: navigator.hardwareConcurrency,
    memoryBytes: Number(readFileSync("/proc/meminfo", "utf8").match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0) * 1024,
    bun: Bun.version,
    chromium: chromeVersion,
    gitCommit: Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim(),
    gitDirty: Bun.spawnSync(["git", "status", "--porcelain"]).stdout.length > 0,
    profiles: benchmarkConfig.profiles,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
