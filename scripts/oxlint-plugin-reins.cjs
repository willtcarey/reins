"use strict";

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
        messages: { forbidden: "Server code must not start, link or dial a node or use link test doubles; the node process dials the server's socket (tests use __tests__/helpers/loopback-node.ts)." },
      },
      create(context) {
        const forbidden = ["@reins/node/node", "@reins/node/node-connection", "@reins/node/local-link", "@reins/node-protocol/testing"];
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
