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
