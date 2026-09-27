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

module.exports = {
  meta: {
    name: "reins",
  },
  rules: {
    "node-import-boundary": {
      meta: {
        type: "problem",
        docs: { description: "Server modules import the node package through its declared exports." },
        messages: { forbidden: "Server code must use @reins/node package exports, not implementation paths." },
      },
      create(context) {
        const check = (node) => {
          const specifier = node.source?.value;
          if (typeof specifier === "string" && (
            (specifier.startsWith("@reins/node") && !["@reins/node/contract", "@reins/node/protocol", "@reins/node/node", "@reins/node/node-connection", "@reins/node/local-link", "@reins/node/storage", "@reins/node/pi-storage", "@reins/node/resources", "@reins/node/prompt", "@reins/node/runtime", "@reins/node/pi-runtime", "@reins/node/host-tools", "@reins/node/runtime-build", "@reins/node/reins-tools", "@reins/node/system-prompt"].includes(specifier))
            || /(?:^|\/)node\/src\//.test(specifier)
          )) context.report({ node, messageId: "forbidden" });
        };
        return { ImportDeclaration: check, ImportExpression: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
      },
    },
    "server-node-process-boundary": {
      meta: {
        type: "problem",
        docs: { description: "The server never starts a node or opens node storage: the node is a separate process." },
        messages: { forbidden: "Server code must not start, link or dial a node, or open node storage; the node process dials the server's socket (tests use __tests__/helpers/loopback-node.ts)." },
      },
      create(context) {
        const runtime = ["@reins/node/node", "@reins/node/node-connection", "@reins/node/local-link"];
        const check = (node) => {
          const specifier = node.source?.value;
          if (typeof specifier !== "string") return;
          const typeOnly = node.importKind === "type" || node.exportKind === "type"
            || (node.specifiers?.length > 0 && node.specifiers.every((item) => item.importKind === "type" || item.exportKind === "type"));
          if (runtime.includes(specifier) || (specifier === "@reins/node/storage" && !typeOnly)) {
            context.report({ node, messageId: "forbidden" });
          }
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
    "node-contract-isolation": {
      meta: {
        type: "problem",
        docs: { description: "Keep node contract independent from daemon implementation." },
        messages: { forbidden: "Node contract must not import daemon or server implementation." },
      },
      create(context) {
        const check = (node) => {
          if (typeof node.source?.value === "string" && node.source.value !== "zod") {
            context.report({ node, messageId: "forbidden" });
          }
        };
        return { ImportDeclaration: check, ImportExpression: check, ExportNamedDeclaration: check, ExportAllDeclaration: check };
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
