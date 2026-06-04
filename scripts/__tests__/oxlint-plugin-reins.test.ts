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
