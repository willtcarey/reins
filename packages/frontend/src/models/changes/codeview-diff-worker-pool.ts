import type { SupportedLanguages } from "@pierre/diffs";
import { getOrCreateWorkerPoolSingleton, type SetupWorkerPoolProps, type WorkerPoolManager } from "@pierre/diffs/worker";

export interface CodeViewDiffWorkerPoolEnvironment {
  hardwareConcurrency?: number;
  maxTouchPoints?: number;
  coarsePointer?: boolean;
}

export const CODEVIEW_DIFF_SHIKI_THEME = "github-dark";
export const CODEVIEW_DIFF_WORKER_LANGS: SupportedLanguages[] = ["cpp", "css", "go", "python", "rust", "sh", "swift", "tsx", "typescript", "zig"];

export function getCodeViewDiffWorkerPoolSetup(options: {
  workerFactory?: () => Worker;
  environment?: CodeViewDiffWorkerPoolEnvironment;
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
      theme: CODEVIEW_DIFF_SHIKI_THEME,
      langs: CODEVIEW_DIFF_WORKER_LANGS,
      preferredHighlighter: "shiki-wasm",
    },
  };
}

export function getCodeViewDiffWorkerPool(): WorkerPoolManager {
  return getOrCreateWorkerPoolSingleton(getCodeViewDiffWorkerPoolSetup());
}

function createPierreDiffWorker(): Worker {
  return new Worker("/dist/models/changes/pierre-diffs-worker.js", { type: "module" });
}

function getCurrentWorkerPoolEnvironment(): CodeViewDiffWorkerPoolEnvironment {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const coarsePointer = typeof window === "undefined" ? undefined : window.matchMedia?.("(pointer: coarse)").matches;
  return {
    hardwareConcurrency: nav?.hardwareConcurrency,
    maxTouchPoints: nav?.maxTouchPoints,
    coarsePointer,
  };
}
