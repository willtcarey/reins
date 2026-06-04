"use strict";

function isExportedTypeAliasRealias(node) {
  const declaration = node.declaration;
  if (!declaration || declaration.type !== "TSTypeAliasDeclaration") return false;

  const annotation = declaration.typeAnnotation;
  return annotation?.type === "TSTypeReference" && !annotation.typeArguments;
}

module.exports = {
  meta: {
    name: "reins",
  },
  rules: {
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
