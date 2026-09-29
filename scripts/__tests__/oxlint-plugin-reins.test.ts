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
    for (const specifier of ["@reins/node", "@reins/node/resources", "@reins/node/runtime", "@reins/node/unknown", "../../../node/src/runtime/context.js", "../../node-protocol/src/schema.js", "../../pi-sql-storage/src/pi-storage.js"]) {
      expect(imports("node-import-boundary", specifier)).toHaveLength(1);
    }
    for (const specifier of ["@reins/node-protocol", "@reins/node-protocol/testing", "@reins/pi-sql-storage", "@reins/nodes", "zod"]) {
      expect(imports("node-import-boundary", specifier)).toHaveLength(0);
    }
    expect(runRule("node-import-boundary", "ImportExpression", { source: { value: "@reins/node/node" } })).toHaveLength(1);
    expect(runRule("node-import-boundary", "ExportNamedDeclaration", { source: { value: "../../../node/src/runtime/context.js" } })).toHaveLength(1);
  });

  test("server code cannot start, link or dial a node or use link test doubles", () => {
    for (const specifier of ["@reins/node/node", "@reins/node/node-connection", "@reins/node/local-link", "@reins/node-protocol/testing"]) {
      expect(imports("server-node-process-boundary", specifier)).toHaveLength(1);
    }
    expect(imports("server-node-process-boundary", "@reins/node/node", { importKind: "type" })).toHaveLength(1);
    expect(runRule("server-node-process-boundary", "ImportExpression", { source: { value: "@reins/node/node" } })).toHaveLength(1);
    for (const specifier of ["@reins/node-protocol", "@reins/pi-sql-storage"]) {
      expect(imports("server-node-process-boundary", specifier)).toHaveLength(0);
    }
  });

  test("the protocol package imports only zod, itself and runtime builtins", () => {
    for (const specifier of ["zod", "./schema.js", "node:os", "bun", "bun:test"]) {
      expect(imports("node-protocol-isolation", specifier)).toHaveLength(0);
    }
    for (const specifier of ["@earendil-works/pi-ai", "@reins/node", "@reins/pi-sql-storage", "../node/src/runtime/types.js"]) {
      expect(imports("node-protocol-isolation", specifier)).toHaveLength(1);
    }
    expect(runRule("node-protocol-isolation", "ImportExpression", { source: { value: "@reins/node" } })).toHaveLength(1);
  });

  test("the Pi SQL storage package imports only Pi, itself and runtime builtins", () => {
    for (const specifier of ["@earendil-works/pi-agent-core", "@earendil-works/pi-agent-core/harness/session", "@earendil-works/pi-ai", "bun:sqlite", "./pi-storage.js"]) {
      expect(imports("pi-sql-storage-isolation", specifier)).toHaveLength(0);
    }
    for (const specifier of ["@reins/node-protocol", "@reins/node/storage", "@reins/backend", "zod", "../../node/src/storage.js"]) {
      expect(imports("pi-sql-storage-isolation", specifier)).toHaveLength(1);
    }
  });

  test("the telemetry package imports only itself, so both the browser and the server can take it", () => {
    for (const specifier of ["./telemetry.js", "bun:test"]) {
      expect(imports("telemetry-isolation", specifier)).toHaveLength(0);
    }
    for (const specifier of ["node:fs", "bun", "zod", "@reins/node-protocol", "../../backend/src/logger.js"]) {
      expect(imports("telemetry-isolation", specifier)).toHaveLength(1);
    }
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
