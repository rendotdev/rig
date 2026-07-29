import type { ESTree } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";
import { sourcePathKey } from "./effect-ast.ts";

export const noBarrelFilesRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Forbid index modules and re-export facades across Rig." },
    messages: {
      indexFile:
        "Barrel files are forbidden. Rename this module for its concrete responsibility and import it directly.",
      reExport:
        "Re-export facades are forbidden. Import the concrete module at each call site instead.",
      barrelImport:
        "Import the concrete module directly; paths resolving to index.ts or index.tsx are forbidden.",
    },
  },
  create(context) {
    return {
      Program(node) {
        if (/(?:^|\/)index\.[cm]?[jt]sx?$/u.test(sourcePathKey(context.filename))) {
          context.report({ node, messageId: "indexFile" });
        }
      },
      ImportDeclaration(node: ESTree.ImportDeclaration) {
        if (isIndexSpecifier(node.source.value)) {
          context.report({ node: node.source, messageId: "barrelImport" });
        }
      },
      ExportAllDeclaration(node: ESTree.ExportAllDeclaration) {
        context.report({ node, messageId: "reExport" });
      },
      ExportNamedDeclaration(node: ESTree.ExportNamedDeclaration) {
        if (node.source) {
          context.report({ node, messageId: "reExport" });
        }
      },
    };
  },
});

function isIndexSpecifier(specifier: string) {
  return /(?:^|\/)index(?:\.[cm]?[jt]sx?)?$/u.test(specifier);
}
