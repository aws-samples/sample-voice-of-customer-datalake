import tseslint from 'typescript-eslint'
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs'
import sonarjs from 'eslint-plugin-sonarjs'
import unicorn from 'eslint-plugin-unicorn'
import vitest from '@vitest/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import { reactRefresh } from 'eslint-plugin-react-refresh'
import globals from 'globals'
import noReExports from '../../eslint-rules/no-re-exports.mjs'
import NATIVE_TITLE from '../../scripts/audit/allowlists/native_title.json' with { type: 'json' }
import {
  SOURCE_RULES,
  SPEC_FILES,
  SPEC_RULES,
  SUPPRESSION_RULES,
  SWALLOWED_REJECTION_SELECTORS,
  TYPE_SAFETY_RULES,
  TYPE_SAFETY_SPEC_RULES,
  withPending,
} from '../../eslint-rules/quality-gates.mjs'

// Rules of the shared quality-gate set (../../eslint-rules/quality-gates.mjs) whose findings in
// this package are not fixed yet, each with the setting this package enforced before ('off' when
// it had none). Delete an entry in the change that brings its count to zero; never add one back.
const PENDING_SOURCE = {}
const PENDING_SPEC = {}
const PENDING_SUPPRESSION = {}

// Every `no-restricted-syntax` entry of the app's TypeScript (ESLint keeps only the last setting of a rule,
// so the block below that adds the native-title ban repeats these).
const RESTRICTED_SYNTAX = [
  {
    selector: 'VariableDeclaration[kind="let"]',
    message: 'Use const. Avoid mutation.',
  },
  ...SWALLOWED_REJECTION_SELECTORS,
]

// Rule 16 (docs/kiro-design-system.md › Tooltips): no native `title` on a DOM element (an iframe's title is
// its accessible name and stays) nor on Link / NavLink, which pass it to their <a>. The files still listed in
// the ratchet (scripts/audit/allowlists/native_title.json, pinned by src/theme/tooltipUsage.test.ts) wait for
// the releases that rewrite them; a file leaves the list, and comes under this rule, when its count is zero.
const NATIVE_TITLE_MESSAGE = 'Use <Tooltip> (docs/kiro-design-system.md › Tooltips): a native title waits 1–2 s and never shows on focus.'
const NATIVE_TITLE_SELECTORS = [
  {
    selector: "JSXOpeningElement[name.name=/^(?!iframe$)[a-z]/] > JSXAttribute[name.name='title']",
    message: NATIVE_TITLE_MESSAGE,
  },
  {
    selector: "JSXOpeningElement[name.name=/^(Link|NavLink)$/] > JSXAttribute[name.name='title']",
    message: NATIVE_TITLE_MESSAGE,
  },
]
const NATIVE_TITLE_PENDING = NATIVE_TITLE.entries.map((entry) => entry.key.replace(/^voc-datalake\/frontend\//u, ''))

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.stryker-tmp/**',
      'reports/**',
      // The production Playwright suite is its own package (e2e/package.json, own tsconfig);
      // it is type-checked by `npx tsc -p e2e/tsconfig.json`, not by the app's lint profile.
      'e2e/**',
      'mock-server.js',
      'vitest.config.ts',
      'stryker.config.mjs',
    ],
  },
  ...tseslint.configs.recommended,
  eslintComments.recommended,
  { rules: withPending(SUPPRESSION_RULES, PENDING_SUPPRESSION) },
  sonarjs.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh.plugin,
      unicorn,
      custom: { rules: { 'no-re-exports': noReExports } },
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Comments policy
      'no-warning-comments': 'off',
      'multiline-comment-style': 'off',
      'capitalized-comments': 'off',
      'no-inline-comments': 'off',
      'spaced-comment': 'off',
      // Ban let - use const only
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],
      // No any types
      // A leading underscore marks a binding kept on purpose (a mock's positional parameter, a
      // loop counter, a destructured field dropped from a rest copy), as in ruff's dummy regex.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      // Shared quality-gate set: size, escape hatches, re-exports, unnecessary logic, promises
      ...withPending(SOURCE_RULES, PENDING_SOURCE),
      ...TYPE_SAFETY_RULES,
      // Added 5.49 wave, owner-approved: console.warn / console.error are the SPA's reporting path
      // (schema drops, failed loads); console.log / info / debug are leftover debugging. And, as in the
      // stream Lambda, no `undefined` spelled out where it is already the default.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // `checkArguments: false`: TypeScript requires an `undefined` argument where the parameter is not
      // optional (zod's `.catch(undefined)`, a spec passing `undefined` to an `unknown` parameter), and the
      // rule's autofix removes it, which breaks the build (and `reduce(fn, undefined)` changes meaning).
      'unicorn/no-useless-undefined': ['error', { checkArguments: false }],
      // Naming conventions
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'parameter',
          format: ['camelCase', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'function',
          format: ['camelCase', 'PascalCase'],
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['PascalCase'],
        },
        {
          selector: ['objectLiteralProperty', 'typeProperty'],
          format: null,
        },
      ],
    },
  },
  {
    // Specs and `src/test/**` are excluded from `tsconfig.app.json`, so the project service cannot
    // type them and every type-aware rule would report a parse error instead of a finding. Point
    // them at `tsconfig.test.json`, which includes all of `src`, rather than widening the app project.
    //
    // ⚠️ This buys LINT coverage, not typecheck coverage: `npm run typecheck` runs against
    // `tsconfig.app.json`, so a type error in a spec fails `lint` (or `typecheck:tests`), not `typecheck`.
    files: [...SPEC_FILES, 'src/test/**/*'],
    plugins: { vitest },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...vitest.environments.env.globals },
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: { ...withPending(SPEC_RULES, PENDING_SPEC), ...TYPE_SAFETY_SPEC_RULES },
  },
  {
    // The app's UI, not its specs (a spec may render a titled element to test what reads it).
    files: ['src/**/*.tsx'],
    ignores: [...SPEC_FILES, 'src/test/**', ...NATIVE_TITLE_PENDING],
    rules: { 'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX, ...NATIVE_TITLE_SELECTORS] },
  },
)
