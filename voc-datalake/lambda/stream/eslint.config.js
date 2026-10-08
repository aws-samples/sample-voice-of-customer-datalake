import tseslint from 'typescript-eslint'
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs'
import sonarjs from 'eslint-plugin-sonarjs'
import pluginPromise from 'eslint-plugin-promise'
import pluginSecurity from 'eslint-plugin-security'
import unicorn from 'eslint-plugin-unicorn'
import importX from 'eslint-plugin-import-x'
import unusedImports from 'eslint-plugin-unused-imports'
import vitest from '@vitest/eslint-plugin'
import globals from 'globals'
import noReExports from '../../../eslint-rules/no-re-exports.mjs'
import {
  SOURCE_RULES,
  SPEC_FILES,
  SPEC_RULES,
  SUPPRESSION_RULES,
  withPending,
} from '../../../eslint-rules/quality-gates.mjs'

// Rules of the shared quality-gate set (../../../eslint-rules/quality-gates.mjs) whose findings in
// this package are not fixed yet, each with the setting this package enforced before ('off' when
// it had none). Delete an entry in the change that brings its count to zero; never add one back.
const PENDING_SOURCE = {}
const PENDING_SPEC = {}
const PENDING_SUPPRESSION = {}

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.stryker-tmp/**', 'reports/**', 'stryker.config.mjs', 'vitest.config.ts'],
  },
  ...tseslint.configs.recommended,
  eslintComments.recommended,
  { rules: withPending(SUPPRESSION_RULES, PENDING_SUPPRESSION) },
  sonarjs.configs.recommended,
  pluginPromise.configs['flat/recommended'],
  pluginSecurity.configs.recommended,

  // ─── Security plugin tuning (reduce false positives) ───
  {
    rules: {
      'security/detect-object-injection': 'off',
      // Underscore-prefixed params are declared-but-unused by convention
      // (e.g. mock signatures that must keep an arg's position/type).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },

  // ─── Shared quality-gate set, for every TS file (specs included) ───
  {
    files: ['**/*.ts'],
    plugins: {
      unicorn,
      custom: { rules: { 'no-re-exports': noReExports } },
    },
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: withPending(SOURCE_RULES, PENDING_SOURCE),
  },

  // ─── Main rules for all TS files ───
  {
    files: ['**/*.ts'],
    ignores: ['**/*.test.ts'],
    plugins: {
      'import-x': importX,
      'unused-imports': unusedImports,
    },
    rules: {
      // ── Comments policy ──
      'no-warning-comments': 'off',
      'multiline-comment-style': 'off',
      'capitalized-comments': 'off',
      'no-inline-comments': 'error',
      'spaced-comment': 'off',

      // ── Immutability ──
      'no-restricted-syntax': [
        'error',
        {
          selector: 'VariableDeclaration[kind="let"]',
          message: 'Use const. Avoid mutation.',
        },
        {
          selector: 'NewExpression[callee.name="Error"]',
          message: 'Use custom error classes instead of generic Error.',
        },
      ],
      'no-negated-condition': 'error',

      // ── Type safety ──
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/prefer-includes': 'error',

      // ── Promise best practices ──
      'promise/always-return': 'error',
      'promise/no-nesting': 'warn',
      'promise/no-return-wrap': 'error',
      'promise/param-names': 'error',
      'promise/catch-or-return': 'error',
      'promise/no-multiple-resolved': 'error',

      // ── Imports ──
      'import-x/no-duplicates': 'error',
      'unused-imports/no-unused-imports': 'error',

      // ── Unicorn (modern JS) ──
      'unicorn/prefer-string-replace-all': 'error',
      'unicorn/prefer-type-error': 'error',
      'unicorn/prefer-array-find': 'error',
      'unicorn/prefer-array-flat-map': 'error',
      'unicorn/prefer-array-some': 'error',
      'unicorn/prefer-includes': 'error',
      'unicorn/prefer-number-properties': 'error',
      'unicorn/prefer-string-starts-ends-with': 'error',
      'unicorn/no-array-for-each': 'error',
      'unicorn/no-useless-undefined': 'error',

      // ── Naming conventions ──
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['camelCase'],
        },
        {
          selector: 'variable',
          modifiers: ['const'],
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
        },
        {
          selector: 'function',
          format: ['camelCase'],
        },
        {
          selector: 'parameter',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
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

  // ─── Test files: shared spec rules, plus this package's own ───
  {
    files: SPEC_FILES,
    plugins: { vitest },
    rules: {
      ...withPending(SPEC_RULES, PENDING_SPEC),
      // Relax production rules for tests (pre-existing; the shared set has no such relaxation)
      'no-inline-comments': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
      'no-restricted-syntax': 'off',
      'security/detect-non-literal-regexp': 'off',

      'vitest/consistent-test-it': ['error', { fn: 'it' }],
      'vitest/consistent-test-filename': ['error', { pattern: '.*\\.test\\.[tj]sx?$' }],
      'vitest/prefer-to-have-length': 'error',
      'vitest/prefer-spy-on': 'error',
    },
  },
)
