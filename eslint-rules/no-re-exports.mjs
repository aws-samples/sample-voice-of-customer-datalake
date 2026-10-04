// Plain JS (each package loads it from its own eslint.config), type-checked through this JSDoc by
// voc-datalake/tsconfig.tools.json and tested in voc-datalake/scripts/quality-gate-rules.test.ts.

/**
 * @param {import('eslint').Scope.Scope} scope
 * @param {string} name
 * @returns {import('eslint').Scope.Variable | undefined}
 */
function findVariable(scope, name) {
  const found = scope.set.get(name);
  if (found) return found;
  return scope.upper ? findVariable(scope.upper, name) : undefined;
}

/**
 * @param {{ type: string } | null | undefined} node
 * @returns {node is import('estree').Identifier}
 */
function isIdentifier(node) {
  return node?.type === 'Identifier';
}

/**
 * @param {import('eslint').Rule.RuleContext} context
 * @param {import('estree').Node} node
 * @param {{ type: string } | null | undefined} identifier
 * @returns {identifier is import('estree').Identifier}
 */
function isImported(context, node, identifier) {
  if (!isIdentifier(identifier)) return false;
  const variable = findVariable(context.sourceCode.getScope(node), identifier.name);
  return Boolean(variable?.defs.some((definition) => definition.type === 'ImportBinding'));
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: "Disallow re-exporting another module's names; import from the defining module" },
    messages: {
      reExportFrom: "Re-export from '{{source}}': import from the defining module where the name is used, and delete this line.",
      reExportImport: "'{{name}}' is imported, not declared here: its importers should import it from the defining module.",
    },
    schema: [],
  },
  create(context) {
    /** @param {import('estree').ExportAllDeclaration | import('estree').ExportNamedDeclaration} node */
    const reportFrom = (node) =>
      context.report({ node, messageId: 'reExportFrom', data: { source: String(node.source?.value) } });
    return {
      ExportAllDeclaration: reportFrom,
      ExportNamedDeclaration(node) {
        if (node.source) {
          reportFrom(node);
          return;
        }
        for (const specifier of node.specifiers) {
          if (isImported(context, node, specifier.local)) {
            context.report({ node: specifier, messageId: 'reExportImport', data: { name: specifier.local.name } });
          }
        }
      },
      ExportDefaultDeclaration(node) {
        if (isImported(context, node, node.declaration)) {
          context.report({ node, messageId: 'reExportImport', data: { name: node.declaration.name } });
        }
      },
    };
  },
};
