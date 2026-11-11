/**
 * `data-layer/no-database-driver`: only the data layer loads the database driver. Code outside
 * `packages/data-schemas` reaches the database through the data layer (`~/models`, the
 * `DataStore` stores and the backend's ports from `@librechat/data-schemas`), so naming one of the
 * driver modules (`mongoose`, `mongodb`, `bson`, the LangGraph MongoDB checkpointer, or a subpath
 * of one) is reported in every form a source can name a module: static imports and
 * `import type`, re-exports, `import()` and `require()` of a literal or a substitution-free
 * template, `import x = require()`, `import('...')` types, and `import('...')` types in JSDoc
 * block comments (the JavaScript sources' types). Where the rule applies, and so what is exempt,
 * is decided by its block in eslint.config.mjs.
 */

const DRIVER_MODULES = ['mongoose', 'mongodb', 'bson', '@langchain/langgraph-checkpoint-mongodb'];

/** The module a specifier names: a bare package name, or the package of a subpath of one. */
const packageOf = (specifier) => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

/** The string a specifier node spells, when it can be read statically. */
const specifierOf = (node) => {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  if (node.type === 'TSLiteralType') return specifierOf(node.literal);
  return undefined;
};

/** An `import()` type naming a module with a quoted specifier, inside a comment's text. */
const JSDOC_IMPORT = /import\(\s*(['"`])([^'"`]+)\1\s*\)/g;

const noDatabaseDriver = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Only the data layer (packages/data-schemas) may load the database driver; other code uses its stores and ports',
    },
    schema: [
      {
        type: 'object',
        properties: { modules: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      driver:
        "'{{specifier}}' is the database driver, which only the data layer (packages/data-schemas) loads. Reach the database through `~/models` / the `DataStore` stores, and name ids, transactions, filters and errors with the neutral types from `@librechat/data-schemas` (`IdLike`, `StoreIdValue`, `StoreTransaction`, `StoreFilter`, `isDuplicateKeyError`, …).",
    },
  },
  create(context) {
    const modules = new Set(context.options[0]?.modules ?? DRIVER_MODULES);
    const isDriver = (specifier) => modules.has(packageOf(specifier));

    const check = (node, source) => {
      const specifier = specifierOf(source);
      if (specifier !== undefined && isDriver(specifier)) {
        context.report({ node, messageId: 'driver', data: { specifier } });
      }
    };

    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type !== 'Block') continue;
          for (const match of comment.value.matchAll(JSDOC_IMPORT)) {
            if (isDriver(match[2])) {
              context.report({
                loc: comment.loc,
                messageId: 'driver',
                data: { specifier: match[2] },
              });
            }
          }
        }
      },
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
      TSImportType: (node) => check(node, node.argument),
      TSExternalModuleReference: (node) => check(node, node.expression),
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        check(node, node.arguments[0]);
      },
    };
  },
};

export default {
  meta: { name: 'data-layer' },
  rules: { 'no-database-driver': noDatabaseDriver },
};
