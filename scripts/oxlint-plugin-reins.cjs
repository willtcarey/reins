"use strict";

const path = require("node:path");

/** The backend's process-owned sources, relative to its `src/` (docs/dev/hot-reload.md *Ownership*): the
 * same list `server-process.ts` treats as restart-only. */
const BACKEND_SRC = path.join(__dirname, "../packages/backend/src");
const PROCESS_OWNED_LIST = "process-owned.json";
const PROCESS_OWNED = new Set(require(path.join(BACKEND_SRC, PROCESS_OWNED_LIST)));
/** The app's entry, which the process owner loads with a dynamic import: the one way it reaches app code. */
const APP_ENTRY = "server.ts";

/** A backend source's path relative to `src/` (POSIX separators), or null outside it. */
function backendSource(filename) {
  const relative = path.relative(BACKEND_SRC, filename);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

/** Whether a process-owned source may import `specifier` at runtime: a package (third-party or builtin), the
 * protocol, or another process-owned source (or the list itself); not another workspace package (it would be
 * bundled per app) nor any app source. */
function processOwnedMayImport(filename, specifier) {
  if (!specifier.startsWith(".")) return !specifier.startsWith("@reins/") || specifier === "@reins/node-protocol";
  const target = backendSource(path.resolve(path.dirname(filename), specifier));
  if (target === null) return false;
  const source = target.replace(/\.js$/, ".ts");
  return PROCESS_OWNED.has(source) || source === PROCESS_OWNED_LIST;
}

/** Whether an import or export declaration brings in types only (erased: no runtime copy). */
function isTypeOnly(node) {
  if (node.importKind === "type" || node.exportKind === "type") return true;
  const specifiers = node.specifiers ?? [];
  return specifiers.length > 0 && specifiers.every(specifier => specifier.importKind === "type" || specifier.exportKind === "type");
}

function isExportedTypeAliasRealias(node) {
  const declaration = node.declaration;
  if (!declaration || declaration.type !== "TSTypeAliasDeclaration") return false;

  const annotation = declaration.typeAnnotation;
  return annotation?.type === "TSTypeReference" && !annotation.typeArguments;
}

function isTelemetryCall(node) {
  if (node?.type === "AwaitExpression" || (node?.type === "UnaryExpression" && node.operator === "void")) {
    return isTelemetryCall(node.argument);
  }
  const callee = node?.type === "CallExpression" ? node.callee : null;
  return callee?.type === "MemberExpression"
    && callee.object?.type === "Identifier"
    && ["clientTelemetry", "telemetry"].includes(callee.object.name)
    && !callee.computed
    && ["record", "flush", "startOperation"].includes(callee.property?.name);
}

/** Pi's modules the node may import at runtime (`reins/node-runs-no-pi`): its execution environment only. */
const NODE_PI_RUNTIME = new Set(["@earendil-works/pi-agent-core/harness/env/nodejs", "@earendil-works/pi-agent-core/harness/context"]);
const isPi = (specifier) => specifier.startsWith("@earendil-works/");
/** Pi's modules the node may import types from. */
const isPiAgentCore = (specifier) => specifier === "@earendil-works/pi-agent-core" || specifier.startsWith("@earendil-works/pi-agent-core/");

/** What @reins/client may import at runtime: its own modules (and bun:test in tests). */
function isClientModule(specifier) {
  return specifier.startsWith("./") || specifier === "bun:test";
}

/** What @reins/client may import types from (`import type` only). */
function isClientTypeSource(specifier) {
  return specifier.startsWith("@reins/backend/") || specifier === "@reins/telemetry";
}

/** The backend package, which the CLI may take types from (`import type`). */
function isBackendPackage(specifier) {
  return specifier === "@reins/backend" || specifier.startsWith("@reins/backend/");
}

/** A backend module that reads or writes the database directly: a store (`src/*-store.ts`), `app-globals.ts`, or
 * Pi's session storage (`pi-storage.ts`), as a module in a folder of `src/` names it. */
function isDatabaseModule(specifier) {
  return /^(?:\.\.\/)+(?:[^./][^/]*-store|app-globals|pi-storage)(?:\.[jt]s)?$/.test(specifier);
}

/** A path into the backend's sources, which the CLI never imports. */
function isBackendPath(specifier) {
  return /(?:^|\/)backend\/src\//.test(specifier);
}

module.exports = {
  meta: {
    name: "reins",
  },
  rules: {
    "node-import-boundary": {
      meta: {
        type: "problem",
        docs: { description: "Server production code does not depend on the node package; shared code lives in @reins/node-protocol." },
        messages: { forbidden: "Server code must not import @reins/node or any package's implementation paths; use @reins/node-protocol (see docs/dev/node-contract.md)." },
      },
      create(context) {
        const check = (node) => {
          const specifier = node.source?.value;
          if (typeof specifier === "string" && (
            specifier === "@reins/node" || specifier.startsWith("@reins/node/")
            || /(?:^|\/)(?:node|node-protocol)\/src\//.test(specifier)
          )) context.report({ node, messageId: "forbidden" });
        };
        return { ImportDeclaration: check, ImportExpression: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
      },
    },
    "server-node-process-boundary": {
      meta: {
        type: "problem",
        docs: { description: "The server never starts a node: the node is a separate process." },
        messages: { forbidden: "Server code must not start, link or dial a node or use node or link test doubles; the node process dials the server's socket (tests use __tests__/helpers/loopback-node.ts)." },
      },
      create(context) {
        const forbidden = ["@reins/node/node", "@reins/node/node-connection", "@reins/node/local-link", "@reins/node/remote-link", "@reins/node/testing", "@reins/node-protocol/testing"];
        const check = (node) => {
          const specifier = node.source?.value;
          if (typeof specifier === "string" && forbidden.includes(specifier)) context.report({ node, messageId: "forbidden" });
        };
        return { ImportDeclaration: check, ImportExpression: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
      },
    },
    "node-implementation-isolation": {
      meta: {
        type: "problem",
        docs: { description: "Node implementation cannot depend on backend implementation." },
        messages: { forbidden: "Node code must not import backend state or tables." },
      },
      create(context) {
        const check = (node) => {
          const specifier = node.source?.value;
          if (typeof specifier === "string" && (specifier.includes("backend") || specifier.startsWith("@backend"))) {
            context.report({ node, messageId: "forbidden" });
          }
        };
        return { ImportDeclaration: check, ImportExpression: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
      },
    },
    "node-runs-no-pi": {
      meta: {
        type: "problem",
        docs: { description: "Nodes run no Pi (ADR-029): of Pi, the node takes only the execution environment its files and shell commands run on, through Pi's narrowest entry points, so the node bundle carries no model, provider or agent code." },
        messages: { forbidden: "Node code may import Pi only from @earendil-works/pi-agent-core/harness/env/nodejs and /harness/context at runtime, and types from @earendil-works/pi-agent-core (see docs/dev/node-bundle.md)." },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            const specifier = node.source?.value;
            if (typeof specifier !== "string" || !isPi(specifier) || NODE_PI_RUNTIME.has(specifier)) return;
            if (node.importKind === "type" && isPiAgentCore(specifier)) return;
            context.report({ node, messageId: "forbidden" });
          },
          ImportExpression(node) {
            const specifier = node.source?.value;
            if (typeof specifier === "string" && isPi(specifier) && !NODE_PI_RUNTIME.has(specifier)) context.report({ node, messageId: "forbidden" });
          },
        };
      },
    },
    "node-protocol-isolation": {
      meta: {
        type: "problem",
        docs: { description: "@reins/node-protocol depends only on zod (and runtime builtins), so both sides can share it." },
        messages: { forbidden: "@reins/node-protocol may import only zod, its own modules and runtime builtins (node:*, bun)." },
      },
      create(context) {
        const check = (node) => {
          const specifier = node.source?.value;
          if (typeof specifier === "string" && !(specifier === "zod" || specifier.startsWith("./") || specifier.startsWith("node:") || specifier === "bun" || specifier.startsWith("bun:"))) {
            context.report({ node, messageId: "forbidden" });
          }
        };
        return { ImportDeclaration: check, ImportExpression: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
      },
    },
    "cli-import-boundary": {
      meta: {
        type: "problem",
        docs: { description: "@reins/cli is the `reins` command, not a library: only backend tests import it (to pair in process)." },
        messages: { forbidden: "Only backend tests may import @reins/cli; shared code belongs in @reins/node, @reins/node-protocol or @reins/client (see docs/dev/node-contract.md)." },
      },
      create(context) {
        const check = (node) => {
          const specifier = node.source?.value;
          if (typeof specifier === "string" && (specifier === "@reins/cli" || specifier.startsWith("@reins/cli/") || /(?:^|\/)cli\/src\//.test(specifier))) {
            context.report({ node, messageId: "forbidden" });
          }
        };
        return { ImportDeclaration: check, ImportExpression: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
      },
    },
    "cli-isolation": {
      meta: {
        type: "problem",
        docs: { description: "The `reins` command reaches the server over HTTP (@reins/client), never by importing it." },
        messages: { forbidden: "@reins/cli imports @reins/backend with `import type` only, and never a backend source path; call the server through @reins/client." },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            const specifier = node.source?.value;
            if (typeof specifier !== "string") return;
            if (isBackendPath(specifier) || (isBackendPackage(specifier) && node.importKind !== "type")) context.report({ node, messageId: "forbidden" });
          },
          ImportExpression(node) {
            const specifier = node.source?.value;
            if (typeof specifier === "string" && (isBackendPackage(specifier) || isBackendPath(specifier))) context.report({ node, messageId: "forbidden" });
          },
        };
      },
    },
    "nodes-through-models": {
      meta: {
        type: "problem",
        docs: { description: "The node link (backend src/nodes/) is an adapter above models: it reaches the database through them." },
        messages: { forbidden: "nodes/ must not import a store, app-globals.js or pi-storage.js at runtime (types only, with `import type`); add a model method instead." },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            const specifier = node.source?.value;
            if (typeof specifier === "string" && isDatabaseModule(specifier) && node.importKind !== "type") context.report({ node, messageId: "forbidden" });
          },
          ImportExpression(node) {
            const specifier = node.source?.value;
            if (typeof specifier === "string" && isDatabaseModule(specifier)) context.report({ node, messageId: "forbidden" });
          },
        };
      },
    },
    "process-owned-imports": {
      meta: {
        type: "problem",
        docs: { description: "Process-owned backend sources (src/process-owned.json) live as long as the process: they import at runtime only each other, @reins/node-protocol and packages, never app code (in dev the app is a separate bundle, so they would get a second copy)." },
        messages: { forbidden: "Process-owned code must not import app code or a reloadable workspace package at runtime ({{specifier}}): import only process-owned sources (src/process-owned.json), @reins/node-protocol, packages, or types (`import type`); reach the app through `ServerProcess.app` (docs/dev/hot-reload.md)." },
      },
      create(context) {
        const filename = context.filename;
        const source = filename ? backendSource(filename) : null;
        if (source === null || !PROCESS_OWNED.has(source)) return {};
        const check = (node, specifier) => {
          if (typeof specifier === "string" && !processOwnedMayImport(filename, specifier)) context.report({ node, messageId: "forbidden", data: { specifier } });
        };
        const declaration = (node) => { if (!isTypeOnly(node)) check(node, node.source?.value); };
        return {
          ImportDeclaration: declaration,
          ExportNamedDeclaration: declaration,
          ExportAllDeclaration: declaration,
          ImportExpression(node) {
            const specifier = node.source?.value;
            // The process owner loads the app by its entry: allowed only as a dynamic import.
            if (typeof specifier === "string" && specifier.startsWith(".") && backendSource(path.resolve(path.dirname(filename), specifier))?.replace(/\.js$/, ".ts") === APP_ENTRY) return;
            check(node, specifier);
          },
        };
      },
    },
    "telemetry-isolation": {
      meta: {
        type: "problem",
        docs: { description: "@reins/telemetry has no dependencies, so the browser bundle and the server can both take it." },
        messages: { forbidden: "@reins/telemetry may import only its own modules (and bun:test in tests)." },
      },
      create(context) {
        const check = (node) => {
          const specifier = node.source?.value;
          if (typeof specifier === "string" && !(specifier.startsWith("./") || specifier === "bun:test")) {
            context.report({ node, messageId: "forbidden" });
          }
        };
        return { ImportDeclaration: check, ImportExpression: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
      },
    },
    "client-isolation": {
      meta: {
        type: "problem",
        docs: { description: "@reins/client runs in the browser, scripts and tests: no runtime dependencies; backend and telemetry types only." },
        messages: {
          forbidden: "@reins/client may import only its own modules (and bun:test in tests), plus types from @reins/backend/* and @reins/telemetry.",
          typeOnly: "@reins/client imports @reins/backend and @reins/telemetry with `import type`; runtime imports are forbidden.",
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            const specifier = node.source?.value;
            if (typeof specifier !== "string" || isClientModule(specifier)) return;
            if (!isClientTypeSource(specifier)) context.report({ node, messageId: "forbidden" });
            else if (node.importKind !== "type") context.report({ node, messageId: "typeOnly" });
          },
          ImportExpression(node) {
            const specifier = node.source?.value;
            if (typeof specifier === "string" && !isClientModule(specifier)) context.report({ node, messageId: "forbidden" });
          },
        };
      },
    },
    "frontend-backend-imports-type-only": {
      meta: {
        type: "problem",
        docs: {
          description: "Keep frontend imports from backend modules type-only.",
        },
        messages: {
          typeOnly: "Frontend imports from @backend must use `import type`; runtime backend imports are forbidden.",
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            if (typeof node.source?.value === "string"
              && node.source.value.startsWith("@backend/")
              && node.importKind !== "type") {
              context.report({ node, messageId: "typeOnly" });
            }
          },
          ImportExpression(node) {
            if (typeof node.source?.value === "string" && node.source.value.startsWith("@backend/")) {
              context.report({ node, messageId: "typeOnly" });
            }
          },
        };
      },
    },

    "no-telemetry-error-guards": {
      meta: {
        type: "problem",
        docs: { description: "Let client telemetry handle its own errors." },
        messages: {
          noGuard: "Telemetry handles its own errors; remove this telemetry-only error guard.",
        },
      },
      create(context) {
        return {
          TryStatement(node) {
            const statements = node.block.body;
            if (node.handler && statements.length > 0 && statements.every((statement) => (
              statement.type === "ExpressionStatement" && isTelemetryCall(statement.expression)
            ))) {
              context.report({ node, messageId: "noGuard" });
            }
          },
          CallExpression(node) {
            const callee = node.callee;
            if (callee?.type === "MemberExpression" && !callee.computed
              && callee.property?.name === "catch" && isTelemetryCall(callee.object)) {
              context.report({ node, messageId: "noGuard" });
            }
          },
        };
      },
    },

    "sdk-contract-isolation": {
      meta: {
        type: "problem",
        docs: { description: "The Reins SDK contract imports nothing, so it can become a types package (docs/dev/reins-sdk.md)." },
        messages: { forbidden: "reins-sdk/contract.ts must not import anything: its types are Reins values defined in it." },
      },
      create(context) {
        const report = (node) => context.report({ node, messageId: "forbidden" });
        return {
          ImportDeclaration: report,
          ImportExpression: report,
          ExportNamedDeclaration(node) { if (node.source) report(node); },
          ExportAllDeclaration: report,
        };
      },
    },

    "features-through-sdk": {
      meta: {
        type: "problem",
        docs: { description: "Built-in features reach the Reins SDK only through the `reins-sdk` specifier, never its host or the app's stores (docs/dev/reins-sdk.md)." },
        messages: { forbidden: "A built-in feature must not import {{specifier}}: import `reins` from \"reins-sdk\" and its types from \"reins-sdk/contract\"." },
      },
      create(context) {
        const stores = /\/(?:app-store|workspace-store|project-files|session-cache|projects-store)\.js$/;
        const check = (node) => {
          const specifier = node.source?.value;
          if (typeof specifier !== "string" || !specifier.startsWith(".")) return;
          if (specifier.includes("reins-sdk/") || stores.test(specifier)) context.report({ node, messageId: "forbidden", data: { specifier } });
        };
        return { ImportDeclaration: check, ImportExpression: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
      },
    },

    "no-reexports": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow re-exporting from another module.",
        },
        messages: {
          noNamedReexport: "Do not re-export from another module; import from the canonical source instead.",
          noExportAll: "Do not re-export everything from another module; import from the canonical source instead.",
        },
      },
      create(context) {
        return {
          ExportNamedDeclaration(node) {
            if (node.source) {
              context.report({ node, messageId: "noNamedReexport" });
            }
          },
          ExportAllDeclaration(node) {
            context.report({ node, messageId: "noExportAll" });
          },
        };
      },
    },

    "no-custom-event-constructor": {
      meta: {
        type: "problem",
        docs: {
          description: "Require frontend CustomEvents to be created by shared event factories.",
        },
        messages: {
          useEventFactory: "Create CustomEvents in components/events.ts and dispatch a typed event factory result instead.",
        },
      },
      create(context) {
        return {
          NewExpression(node) {
            if (node.callee?.type === "Identifier" && node.callee.name === "CustomEvent") {
              context.report({ node, messageId: "useEventFactory" });
            }
          },
        };
      },
    },

    "no-inline-svg": {
      meta: {
        type: "problem",
        docs: {
          description: "Require frontend SVG icons to be defined in the shared icons module.",
        },
        messages: {
          noInlineSvg: "Define SVG icons in ui/icons.ts and import the icon function instead.",
        },
      },
      create(context) {
        return {
          TaggedTemplateExpression(node) {
            const isSvgTemplate = node.tag?.type === "Identifier" && node.tag.name === "svg";
            const templateSource = node.quasi?.quasis
              ?.map((quasi) => quasi.value?.raw ?? "")
              .join("") ?? "";
            if (isSvgTemplate || /<svg(?:\s|>)/i.test(templateSource)) {
              context.report({ node, messageId: "noInlineSvg" });
            }
          },
        };
      },
    },

    "no-exported-type-realiases": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow exported type aliases that only rename another type.",
        },
        messages: {
          noTypeRealias: "Do not export a type alias that only renames another type; export the canonical type or define a real shape instead.",
        },
      },
      create(context) {
        return {
          ExportNamedDeclaration(node) {
            if (isExportedTypeAliasRealias(node)) {
              context.report({ node: node.declaration, messageId: "noTypeRealias" });
            }
          },
        };
      },
    },
  },
};
