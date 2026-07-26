import type { FileDiffMetadata, SupportedLanguages } from "@pierre/diffs";
import {
  getOrCreateWorkerPoolSingleton,
  type DiffRendererInstance,
  type SetupWorkerPoolProps,
  type WorkerPoolManager,
} from "@pierre/diffs/worker";

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

type DiffHighlightErrorListener = (error: unknown) => void;

const diffHighlightErrorListeners = new Map<string, Set<DiffHighlightErrorListener>>();
let observableWorkerPool: WorkerPoolManager | null = null;

/** Subscribe to asynchronous Pierre highlighting failures for one diff cache key. */
export function subscribeToPierreDiffHighlightErrors(
  cacheKey: string,
  listener: DiffHighlightErrorListener,
): () => void {
  const listeners = diffHighlightErrorListeners.get(cacheKey) ?? new Set();
  listeners.add(listener);
  diffHighlightErrorListeners.set(cacheKey, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) diffHighlightErrorListeners.delete(cacheKey);
  };
}

export function getPierreWorkerPool(): WorkerPoolManager {
  if (observableWorkerPool) return observableWorkerPool;

  const workerPool = getOrCreateWorkerPoolSingleton(getPierreWorkerPoolSetup());
  const wrappedInstances = new WeakMap<DiffRendererInstance, {
    cacheKey: string | undefined;
    proxy: DiffRendererInstance;
  }>();
  observableWorkerPool = new Proxy(workerPool, {
    get(target, property) {
      if (property === "highlightDiffAST") {
        return (instance: DiffRendererInstance, diff: FileDiffMetadata) => {
          let wrapped = wrappedInstances.get(instance);
          if (!wrapped) {
            wrapped = {
              cacheKey: diff.cacheKey,
              proxy: new Proxy<DiffRendererInstance>(instance, {
                get(renderer, rendererProperty) {
                  if (rendererProperty === "onHighlightError") {
                    return (error: unknown) => {
                      const cacheKey = wrapped?.cacheKey;
                      if (cacheKey) {
                        for (const listener of diffHighlightErrorListeners.get(cacheKey) ?? []) listener(error);
                      }
                      return Reflect.get(renderer, rendererProperty).call(renderer, error);
                    };
                  }
                  const value = Reflect.get(renderer, rendererProperty);
                  return typeof value === "function" ? value.bind(renderer) : value;
                },
              }),
            };
            wrappedInstances.set(instance, wrapped);
          }
          wrapped.cacheKey = diff.cacheKey;
          return target.highlightDiffAST(wrapped.proxy, diff);
        };
      }
      if (property === "cleanUpTasks") {
        return (instance: DiffRendererInstance) => {
          const wrapped = wrappedInstances.get(instance);
          target.cleanUpTasks(wrapped?.proxy ?? instance);
          wrappedInstances.delete(instance);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return observableWorkerPool;
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
