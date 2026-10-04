import tseslint from 'typescript-eslint'
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs'
import sonarjs from 'eslint-plugin-sonarjs'
import unicorn from 'eslint-plugin-unicorn'
import vitest from '@vitest/eslint-plugin'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import noReExports from '../../eslint-rules/no-re-exports.mjs'
import {
  QUALITY_BASELINE,
  SOURCE_RULES,
  SPEC_FILES,
  SPEC_RULES,
  SUPPRESSION_RULES,
  withPending,
} from '../../eslint-rules/quality-gates.mjs'

// Rules of the shared quality-gate set (../../eslint-rules/quality-gates.mjs) whose findings in
// this package are not fixed yet, each with the setting this package enforced before ('off' when
// it had none). Delete an entry in the change that brings its count to zero; never add one back.
const PENDING_SOURCE = {
  'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
  'custom/no-re-exports': 'off',
  '@typescript-eslint/no-unnecessary-condition': 'off',
  '@typescript-eslint/no-unnecessary-template-expression': 'off',
  '@typescript-eslint/no-redundant-type-constituents': 'off',
  '@typescript-eslint/prefer-nullish-coalescing': 'off',
  '@typescript-eslint/prefer-optional-chain': 'off',
  'no-useless-return': 'off',
  'unicorn/no-useless-spread': 'off',
  'unicorn/no-useless-fallback-in-spread': 'off',
  '@typescript-eslint/no-floating-promises': 'off',
}
const PENDING_SPEC = {}
const PENDING_SUPPRESSION = {
  '@eslint-community/eslint-comments/no-use': [
    'error',
    { allow: ['eslint-disable', 'eslint-enable', 'eslint-disable-next-line'] },
  ],
}

// Spec files are linted only under QUALITY_BASELINE until their findings are fixed: the suite
// carries a backlog, and #374's guard below is the one spec in the gate today.
const SPECS_PENDING = true
const lintSpecs = QUALITY_BASELINE || !SPECS_PENDING

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.stryker-tmp/**',
      'reports/**',
      'mock-server.js',
      ...(lintSpecs
        ? []
        : [
            '**/*.test.ts',
            // #374 argues that an asset survived in `public/` because no gate read it.
            // The guard that now reads `public/` is itself a `*.test.ts`, so shipping
            // it under this ignore would repeat the finding it exists to prevent.
            '!src/publicAssets.test.ts',
            '**/*.test.tsx',
            'src/test/**/*',
          ]),
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
      'react-refresh': reactRefresh,
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
      'no-restricted-syntax': [
        'error',
        {
          selector: 'VariableDeclaration[kind="let"]',
          message: 'Use const. Avoid mutation.',
        },
      ],
      // No any types
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      // Shared quality-gate set: size, escape hatches, re-exports, unnecessary logic, promises
      ...withPending(SOURCE_RULES, PENDING_SOURCE),
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
    rules: withPending(SPEC_RULES, PENDING_SPEC),
  },
)
