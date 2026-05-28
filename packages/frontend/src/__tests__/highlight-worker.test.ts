import { expect, mock, test } from "bun:test";

interface HighlightRequest {
  id: number;
  type: "highlight";
  files: Array<{ path: string; lang?: string; hunks: Array<{ lines: string[] }> }>;
}

interface FakeHighlighter {
  loadLanguage(lang: string): Promise<void>;
  codeToHtml(source: string, options?: unknown): string;
}

let createHighlighterImpl: () => Promise<FakeHighlighter> = async () => ({
  loadLanguage: async () => {},
  codeToHtml: (source) => source,
});

mock.module("shiki/bundle/full", () => ({
  createHighlighter: () => createHighlighterImpl(),
  bundledLanguages: {
    javascript: {},
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function request(id: number, path: string): HighlightRequest {
  return {
    id,
    type: "highlight",
    files: [{ path, hunks: [{ lines: ["const value = 1;"] }] }],
  };
}

async function loadWorker(responses: unknown[]) {
  const previousOnMessage = globalThis.onmessage;
  const previousPostMessage = globalThis.postMessage;

  Object.defineProperty(globalThis, "postMessage", {
    value: (message: unknown) => {
      responses.push(message);
    },
    configurable: true,
    writable: true,
  });

  await import(`../models/changes/highlight-worker.js?test=${crypto.randomUUID()}`);

  const handler = globalThis.onmessage;
  if (!handler) throw new Error("highlight worker did not install onmessage");

  return {
    post(data: HighlightRequest) {
      return Promise.resolve(handler.call(globalThis.window, new MessageEvent("message", { data })));
    },
    restore() {
      globalThis.onmessage = previousOnMessage;
      Object.defineProperty(globalThis, "postMessage", {
        value: previousPostMessage,
        configurable: true,
        writable: true,
      });
    },
  };
}

test("highlight worker shares pending Shiki and language loads across concurrent messages", async () => {
  const highlighterGate = deferred<FakeHighlighter>();
  let createCalls = 0;
  createHighlighterImpl = () => {
    createCalls++;
    return highlighterGate.promise;
  };

  const responses: unknown[] = [];
  const firstWorker = await loadWorker(responses);
  try {
    const p1 = firstWorker.post(request(1, "file.unknown"));
    const p2 = firstWorker.post(request(2, "other.unknown"));

    expect(createCalls).toBe(1);

    highlighterGate.resolve({
      loadLanguage: async () => {},
      codeToHtml: (source) => source,
    });

    await Promise.all([p1, p2]);
    expect(responses).toHaveLength(2);
  } finally {
    firstWorker.restore();
  }

  const languageGate = deferred<void>();
  const loadCalls: string[] = [];
  createCalls = 0;
  createHighlighterImpl = async () => {
    createCalls++;
    return {
      loadLanguage: async (lang: string) => {
        loadCalls.push(lang);
        await languageGate.promise;
      },
      codeToHtml: (source) => source.replace(/\n/g, "<br>"),
    };
  };

  const languageResponses: unknown[] = [];
  const secondWorker = await loadWorker(languageResponses);
  try {
    const p1 = secondWorker.post(request(3, "file.js"));
    const p2 = secondWorker.post(request(4, "other.js"));

    await flushMicrotasks();

    expect(createCalls).toBe(1);
    expect(loadCalls).toEqual(["javascript"]);

    languageGate.resolve();
    await Promise.all([p1, p2]);
    expect(languageResponses).toHaveLength(2);
  } finally {
    secondWorker.restore();
  }
});
