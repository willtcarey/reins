import { describe, expect, test } from "bun:test";
import plugin from "../oxlint-plugin-reins.cjs";

function runRule(ruleName: keyof typeof plugin.rules, visitorName: string, node: Record<string, unknown>) {
  const reports: unknown[] = [];
  const rule = plugin.rules[ruleName];
  const visitor = rule.create({
    report(diagnostic: unknown) {
      reports.push(diagnostic);
    },
  });

  visitor[visitorName]?.(node);
  return reports;
}

function catchCall(object: object) {
  return {
    type: "CallExpression",
    callee: {
      type: "MemberExpression", object,
      property: { type: "Identifier", name: "catch" }, computed: false,
    },
  };
}

describe("reins/frontend-backend-imports-type-only", () => {
  test("rejects runtime backend imports from frontend code", () => {
    const reports = runRule("frontend-backend-imports-type-only", "ImportDeclaration", {
      source: { value: "@backend/api-types.js" },
      importKind: "value",
    });

    expect(reports).toHaveLength(1);
  });

  test("allows type-only backend imports", () => {
    const reports = runRule("frontend-backend-imports-type-only", "ImportDeclaration", {
      source: { value: "@backend/api-types.js" },
      importKind: "type",
    });

    expect(reports).toHaveLength(0);
  });

  test("rejects dynamic backend imports", () => {
    const reports = runRule("frontend-backend-imports-type-only", "ImportExpression", {
      source: { value: "@backend/project-store.js" },
    });

    expect(reports).toHaveLength(1);
  });
});

describe("reins/node-import-boundary", () => {
  const imports = (rule: keyof typeof plugin.rules, specifier: string, extra: Record<string, unknown> = {}) =>
    runRule(rule, "ImportDeclaration", { source: { value: specifier }, specifiers: [], ...extra });

  test("server code does not import the node package, only the shared packages", () => {
    for (const specifier of ["@reins/node", "@reins/node/install", "@reins/node/unknown", "../../../node/src/pi-exec.js", "../../node-protocol/src/node-methods.js"]) {
      expect(imports("node-import-boundary", specifier)).toHaveLength(1);
    }
    for (const specifier of ["@reins/node-protocol", "@reins/node-protocol/testing", "@reins/nodes", "zod"]) {
      expect(imports("node-import-boundary", specifier)).toHaveLength(0);
    }
    expect(runRule("node-import-boundary", "ImportExpression", { source: { value: "@reins/node/node" } })).toHaveLength(1);
    expect(runRule("node-import-boundary", "ExportNamedDeclaration", { source: { value: "../../../node/src/pi-exec.js" } })).toHaveLength(1);
  });

  test("server code cannot start, link or dial a node or use node or link test doubles", () => {
    for (const specifier of ["@reins/node/node", "@reins/node/node-connection", "@reins/node/local-link", "@reins/node/remote-link", "@reins/node/testing", "@reins/node-protocol/testing"]) {
      expect(imports("server-node-process-boundary", specifier)).toHaveLength(1);
    }
    expect(imports("server-node-process-boundary", "@reins/node/node", { importKind: "type" })).toHaveLength(1);
    expect(runRule("server-node-process-boundary", "ImportExpression", { source: { value: "@reins/node/node" } })).toHaveLength(1);
    expect(imports("server-node-process-boundary", "@reins/node-protocol")).toHaveLength(0);
  });

  test("the node runs no Pi: only Pi's execution environment at runtime, and its types", () => {
    for (const specifier of ["@earendil-works/pi-agent-core/harness/env/nodejs", "@earendil-works/pi-agent-core/harness/context", "zod"]) {
      expect(imports("node-runs-no-pi", specifier)).toHaveLength(0);
    }
    expect(imports("node-runs-no-pi", "@earendil-works/pi-agent-core", { importKind: "type" })).toHaveLength(0);
    for (const specifier of ["@earendil-works/pi-agent-core", "@earendil-works/pi-agent-core/node", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
      expect(imports("node-runs-no-pi", specifier)).toHaveLength(1);
    }
    expect(imports("node-runs-no-pi", "@earendil-works/pi-ai", { importKind: "type" })).toHaveLength(1);
    expect(runRule("node-runs-no-pi", "ImportExpression", { source: { value: "@earendil-works/pi-ai/bun-oauth" } })).toHaveLength(1);
  });

  test("the protocol package imports only zod, itself and runtime builtins", () => {
    for (const specifier of ["zod", "./schema.js", "node:os", "bun", "bun:test"]) {
      expect(imports("node-protocol-isolation", specifier)).toHaveLength(0);
    }
    for (const specifier of ["@earendil-works/pi-ai", "@reins/node", "../node/src/node.js"]) {
      expect(imports("node-protocol-isolation", specifier)).toHaveLength(1);
    }
    expect(runRule("node-protocol-isolation", "ImportExpression", { source: { value: "@reins/node" } })).toHaveLength(1);
  });

  test("the telemetry package imports only itself, so both the browser and the server can take it", () => {
    for (const specifier of ["./telemetry.js", "bun:test"]) {
      expect(imports("telemetry-isolation", specifier)).toHaveLength(0);
    }
    for (const specifier of ["node:fs", "bun", "zod", "@reins/node-protocol", "../../backend/src/logger.js"]) {
      expect(imports("telemetry-isolation", specifier)).toHaveLength(1);
    }
  });

  test("the client package imports only itself at runtime, and backend and telemetry types type-only", () => {
    for (const specifier of ["./reins-client.js", "bun:test"]) {
      expect(imports("client-isolation", specifier)).toHaveLength(0);
    }
    for (const specifier of ["@reins/backend/routes/nodes.js", "@reins/telemetry"]) {
      expect(imports("client-isolation", specifier, { importKind: "type" })).toHaveLength(0);
      expect(imports("client-isolation", specifier, { importKind: "value" })).toHaveLength(1);
    }
    for (const specifier of ["@reins/node-protocol", "zod", "node:path", "../../backend/src/routes/nodes.js", "@backend/routes/nodes.js"]) {
      expect(imports("client-isolation", specifier, { importKind: "type" })).toHaveLength(1);
    }
    expect(runRule("client-isolation", "ImportExpression", { source: { value: "@reins/backend/routes/nodes.js" } })).toHaveLength(1);
  });

  test("no package imports the CLI", () => {
    for (const specifier of ["@reins/cli", "@reins/cli/node/pair", "../../cli/src/node/pair.js"]) {
      expect(imports("cli-import-boundary", specifier)).toHaveLength(1);
    }
    for (const specifier of ["@reins/client", "../../client/src/reins-client.js", "./cli.js"]) {
      expect(imports("cli-import-boundary", specifier)).toHaveLength(0);
    }
    expect(runRule("cli-import-boundary", "ImportExpression", { source: { value: "@reins/cli/node/pair" } })).toHaveLength(1);
  });

  test("the CLI takes only types from the backend, and never from its sources", () => {
    for (const specifier of ["@reins/backend/routes/nodes.js", "@reins/backend"]) {
      expect(imports("cli-isolation", specifier, { importKind: "type" })).toHaveLength(0);
      expect(imports("cli-isolation", specifier, { importKind: "value" })).toHaveLength(1);
      expect(runRule("cli-isolation", "ImportExpression", { source: { value: specifier } })).toHaveLength(1);
    }
    expect(imports("cli-isolation", "../../../backend/src/routes/nodes.js", { importKind: "type" })).toHaveLength(1);
    for (const specifier of ["@reins/client", "@reins/node/install", "@reins/node-protocol", "zod", "./command.js"]) {
      expect(imports("cli-isolation", specifier, { importKind: "value" })).toHaveLength(0);
    }
  });
});

describe("reins/nodes-through-models", () => {
  const imports = (specifier: string, importKind = "value") =>
    runRule("nodes-through-models", "ImportDeclaration", { source: { value: specifier }, specifiers: [], importKind });

  test("the node link reaches the database only through models: no store, app-globals.js or Pi storage at runtime", () => {
    for (const specifier of ["../session-store.js", "../node-store.js", "../task-store.js", "../app-globals.js", "../pi-storage.js"]) {
      expect(imports(specifier)).toHaveLength(1);
      expect(runRule("nodes-through-models", "ImportExpression", { source: { value: specifier } })).toHaveLength(1);
    }
  });

  test("stores may still be imported as types, and models at runtime", () => {
    for (const specifier of ["../session-store.js", "../app-globals.js", "../pi-storage.js"]) {
      expect(imports(specifier, "type")).toHaveLength(0);
    }
    for (const specifier of ["../models/sessions.js", "../pi/credential-store.js", "../sessions/session-runs.js", "@reins/node-protocol"]) {
      expect(imports(specifier)).toHaveLength(0);
    }
  });
});

describe("reins/process-owned-imports", () => {
  const src = new URL("../../packages/backend/src/", import.meta.url).pathname;
  /** The reports for one import in backend source `file` (relative to src/). */
  const imports = (file: string, specifier: string, { visitor = "ImportDeclaration", ...extra }: { visitor?: string } & Record<string, unknown> = {}) => {
    const reports: unknown[] = [];
    const rule = plugin.rules["process-owned-imports"];
    const visitors = rule.create({ filename: src + file, report: (diagnostic: unknown) => reports.push(diagnostic) });
    visitors[visitor]?.({ source: { value: specifier }, specifiers: [], importKind: "value", ...extra });
    return reports;
  };

  test("a process-owned source imports at runtime only process-owned sources, the protocol and packages", () => {
    for (const specifier of ["./logger.js", "./database.js", "@reins/node-protocol", "node:fs", "bun:sqlite", "zod"]) {
      expect(imports("process-state.ts", specifier)).toHaveLength(0);
    }
    expect(imports("server-process.ts", "./process-owned.json")).toHaveLength(0);
    for (const specifier of ["./models/models.js", "./app-globals.js", "./node-store.js", "./nodes/node-hub.js", "@reins/telemetry", "@reins/node-protocol/testing"]) {
      expect(imports("process-state.ts", specifier)).toHaveLength(1);
    }
    expect(imports("process-state.ts", "./models/nodes.js", { visitor: "ExportNamedDeclaration" })).toHaveLength(1);
    expect(imports("process-state.ts", "./models/nodes.js", { visitor: "ImportExpression" })).toHaveLength(1);
  });

  test("types from app code are allowed, and the process owner may load the app's entry dynamically", () => {
    expect(imports("process-state.ts", "./state.js", { importKind: "type" })).toHaveLength(0);
    expect(imports("process-state.ts", "./state.js", { specifiers: [{ importKind: "type" }, { importKind: "type" }] })).toHaveLength(0);
    expect(imports("process-state.ts", "./state.js", { specifiers: [{ importKind: "type" }, { importKind: "value" }] })).toHaveLength(1);
    expect(imports("server-process.ts", "./server.js", { visitor: "ImportExpression" })).toHaveLength(0);
    expect(imports("server-process.ts", "./server.js")).toHaveLength(1);
  });

  test("app code is not constrained", () => {
    expect(imports("nodes/node-hub.ts", "../models/models.js")).toHaveLength(0);
    expect(imports("server.ts", "./app-globals.js")).toHaveLength(0);
  });
});

describe("reins/no-telemetry-error-guards", () => {
  const record = {
    type: "CallExpression",
    callee: {
      type: "MemberExpression",
      object: { type: "Identifier", name: "clientTelemetry" },
      property: { type: "Identifier", name: "record" },
      computed: false,
    },
  };
  const statement = { type: "ExpressionStatement", expression: record };

  test("rejects a catch protecting only telemetry calls", () => {
    const reports = runRule("no-telemetry-error-guards", "TryStatement", {
      block: { body: [statement, {
        type: "ExpressionStatement",
        expression: { type: "UnaryExpression", operator: "void", argument: {
          type: "AwaitExpression", argument: record,
        } },
      }] }, handler: { type: "CatchClause" },
    });
    expect(reports).toHaveLength(1);
  });

  test("allows application error handling, including reporting inside its catch", () => {
    const applicationCall = {
      type: "ExpressionStatement",
      expression: { type: "CallExpression", callee: { type: "Identifier", name: "render" } },
    };
    expect(runRule("no-telemetry-error-guards", "TryStatement", {
      block: { body: [applicationCall, statement] },
      handler: { type: "CatchClause", body: { body: [statement] } },
    })).toHaveLength(0);
    expect(runRule("no-telemetry-error-guards", "TryStatement", {
      block: { body: [statement] }, handler: null, finalizer: { body: [] },
    })).toHaveLength(0);
  });

  test("rejects telemetry promise catch handlers but allows other promise catches", () => {
    const flush = { ...record, callee: { ...record.callee, property: { type: "Identifier", name: "flush" } } };
    expect(runRule("no-telemetry-error-guards", "CallExpression", catchCall(flush))).toHaveLength(1);
    expect(runRule("no-telemetry-error-guards", "CallExpression", catchCall({
      type: "CallExpression", callee: { type: "Identifier", name: "fetch" },
    }))).toHaveLength(0);
  });
});

describe("reins/no-reexports", () => {
  test("reports named re-exports from another module", () => {
    const reports = runRule("no-reexports", "ExportNamedDeclaration", {
      type: "ExportNamedDeclaration",
      source: { type: "Literal", value: "./other" },
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ messageId: "noNamedReexport" });
  });

  test("reports export-all declarations", () => {
    const reports = runRule("no-reexports", "ExportAllDeclaration", {
      type: "ExportAllDeclaration",
      source: { type: "Literal", value: "./other" },
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ messageId: "noExportAll" });
  });

  test("allows local named exports", () => {
    const reports = runRule("no-reexports", "ExportNamedDeclaration", {
      type: "ExportNamedDeclaration",
      source: null,
      specifiers: [],
    });

    expect(reports).toHaveLength(0);
  });
});

describe("reins/no-exported-type-realiases", () => {
  test("reports exported aliases that only rename another type", () => {
    const declaration = {
      type: "TSTypeAliasDeclaration",
      id: { type: "Identifier", name: "RuntimePromptContent" },
      typeAnnotation: {
        type: "TSTypeReference",
        typeName: { type: "Identifier", name: "ClientPromptContent" },
        typeArguments: null,
      },
    };

    const reports = runRule("no-exported-type-realiases", "ExportNamedDeclaration", {
      type: "ExportNamedDeclaration",
      source: null,
      declaration,
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ node: declaration, messageId: "noTypeRealias" });
  });

  test("allows primitive aliases", () => {
    const reports = runRule("no-exported-type-realiases", "ExportNamedDeclaration", {
      type: "ExportNamedDeclaration",
      source: null,
      declaration: {
        type: "TSTypeAliasDeclaration",
        id: { type: "Identifier", name: "LogLevel" },
        typeAnnotation: { type: "TSStringKeyword" },
      },
    });

    expect(reports).toHaveLength(0);
  });

  test("allows composed aliases", () => {
    const reports = runRule("no-exported-type-realiases", "ExportNamedDeclaration", {
      type: "ExportNamedDeclaration",
      source: null,
      declaration: {
        type: "TSTypeAliasDeclaration",
        id: { type: "Identifier", name: "Mode" },
        typeAnnotation: {
          type: "TSUnionType",
          types: [
            { type: "TSLiteralType", literal: { type: "Literal", value: "code" } },
            { type: "TSLiteralType", literal: { type: "Literal", value: "preview" } },
          ],
        },
      },
    });

    expect(reports).toHaveLength(0);
  });
});

describe("reins/sdk-contract-isolation", () => {
  test("the SDK contract imports nothing, not even types", () => {
    expect(runRule("sdk-contract-isolation", "ImportDeclaration", { source: { value: "../models/inspector.js" }, importKind: "type" })).toHaveLength(1);
    expect(runRule("sdk-contract-isolation", "ExportNamedDeclaration", { source: { value: "./other.js" } })).toHaveLength(1);
    expect(runRule("sdk-contract-isolation", "ExportNamedDeclaration", { source: null })).toHaveLength(0);
  });
});

describe("reins/features-through-sdk", () => {
  const imports = (specifier: string) => runRule("features-through-sdk", "ImportDeclaration", { source: { value: specifier }, importKind: "type" });

  test("a built-in feature imports neither the app's stores nor the SDK's host", () => {
    for (const specifier of ["../stores/app-store.js", "./workspace-store.js", "../../models/stores/project-files.js", "../reins-sdk/host.js", "../../reins-sdk/decorations.js"]) {
      expect(imports(specifier)).toHaveLength(1);
    }
  });

  test("it imports the SDK contract and its own modules", () => {
    for (const specifier of ["../../reins-sdk/contract.js", "./file-browser-store.js", "../file-loader.js"]) {
      expect(imports(specifier)).toHaveLength(0);
    }
  });
});
