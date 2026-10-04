function findVariable(scope, name) {
  const found = scope.set.get(name);
  if (found) return found;
  return scope.upper ? findVariable(scope.upper, name) : undefined;
}

function isImported(context, node, identifier) {
  if (identifier?.type !== 'Identifier') return false;
  const variable = findVariable(context.sourceCode.getScope(node), identifier.name);
  return Boolean(variable?.defs.some((definition) => definition.type === 'ImportBinding'));
}

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
    const reportFrom = (node) => context.report({ node, messageId: 'reExportFrom', data: { source: node.source.value } });
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
