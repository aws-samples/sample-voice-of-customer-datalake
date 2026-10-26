/**
 * Lints the gate code itself (this directory), which decides what every package may merge.
 *
 * ESLint never lints a file outside its config's directory, so the packages' configs cannot reach
 * here; this config can. It runs from this directory with voc-datalake's eslint binary
 * (`npm run lint:gates`, a validate.sh step), whose node_modules supply the plugins, and type-checks
 * the gate files through voc-datalake/tsconfig.tools.json (checkJs + JSDoc), which lists them and
 * excludes this config. Same shared source rules as the packages.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SOURCE_RULES, SUPPRESSION_RULES, withPending } from './quality-gates.mjs';
import noReExports from './no-re-exports.mjs';

const CDK = path.join(import.meta.dirname, '..', 'voc-datalake');
const resolveFromCdk = createRequire(path.join(CDK, 'package.json')).resolve;
/** A package from voc-datalake/node_modules, as its default export (the plugins are ESM). */
const load = async (name) => {
  const mod = await import(pathToFileURL(resolveFromCdk(name)).href);
  return mod.default ?? mod;
};
const tseslint = await load('typescript-eslint');
const sonarjs = await load('eslint-plugin-sonarjs');
const unicorn = await load('eslint-plugin-unicorn');
const eslintComments = await load('@eslint-community/eslint-plugin-eslint-comments/configs');

export default tseslint.config(
  { ignores: ['eslint.config.mjs'] },
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  eslintComments.recommended,
  {
    files: ['*.mjs'],
    languageOptions: {
      parserOptions: { project: [path.join(CDK, 'tsconfig.tools.json')], tsconfigRootDir: CDK },
    },
    plugins: { unicorn, custom: { rules: { 'no-re-exports': noReExports } } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: { ...withPending(SUPPRESSION_RULES, {}), ...withPending(SOURCE_RULES, {}) },
  },
);
