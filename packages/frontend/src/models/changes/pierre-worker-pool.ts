import type { SupportedLanguages } from "@pierre/diffs";
import { getOrCreateWorkerPoolSingleton, type SetupWorkerPoolProps, type WorkerPoolManager } from "@pierre/diffs/worker";

export interface PierreWorkerPoolEnvironment {
  hardwareConcurrency?: number;
  maxTouchPoints?: number;
  coarsePointer?: boolean;
}

export const PIERRE_SHIKI_THEME = "github-dark";
export const PIERRE_WORKER_LANGS: SupportedLanguages[] = ["cpp", "css", "go", "python", "rust", "sh", "swift", "tsx", "typescript", "zig"];

export function getPierreWorkerPoolSetup(options: {
  workerFactory?: () => Worker;
  environment?: PierreWorkerPoolEnvironment;
} = {}): SetupWorkerPoolProps {
  const workerFactory = options.workerFactory ?? createPierreDiffWorker;
  const environment = options.environment ?? getCurrentWorkerPoolEnvironment();
  const coarsePointer = environment.coarsePointer ?? (environment.maxTouchPoints ?? 0) > 0;
  const hardwareConcurrency = environment.hardwareConcurrency ?? 2;
  const poolOptions = coarsePointer
    ? { poolSize: 1, totalASTLRUCacheSize: 10 }
    : { poolSize: Math.min(Math.max(1, hardwareConcurrency - 1), 3), totalASTLRUCacheSize: 100 };

  return {
    poolOptions: {
      workerFactory,
      ...poolOptions,
    },
    highlighterOptions: {
      theme: PIERRE_SHIKI_THEME,
      langs: PIERRE_WORKER_LANGS,
      preferredHighlighter: "shiki-wasm",
    },
  };
}

export function getPierreWorkerPool(): WorkerPoolManager {
  return getOrCreateWorkerPoolSingleton(getPierreWorkerPoolSetup());
}

function createPierreDiffWorker(): Worker {
  return new Worker("/dist/models/changes/pierre-diffs-worker.js", { type: "module" });
}

function getCurrentWorkerPoolEnvironment(): PierreWorkerPoolEnvironment {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const coarsePointer = typeof window === "undefined" ? undefined : window.matchMedia?.("(pointer: coarse)").matches;
  return {
    hardwareConcurrency: nav?.hardwareConcurrency,
    maxTouchPoints: nav?.maxTouchPoints,
    coarsePointer,
  };
}
