// ESLint for the CDK app (bin/, lib/, scripts/). The frontend and the streaming Lambda have their
// own configs and node_modules, so they are ignored here.
import tseslint from 'typescript-eslint';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import vitest from '@vitest/eslint-plugin';
import noReExports from '../eslint-rules/no-re-exports.mjs';
import {
  QUALITY_BASELINE,
  SOURCE_RULES,
  SPEC_FILES,
  SPEC_RULES,
  SUPPRESSION_RULES,
  pendingPresetRules,
  withPending,
} from '../eslint-rules/quality-gates.mjs';

// Rules of the shared quality-gate set (../eslint-rules/quality-gates.mjs) whose findings in this
// package are not fixed yet. The CDK app had no ESLint before, so each previous setting is 'off'.
// Delete an entry in the change that brings its count to zero; never add one back.
const PENDING_SOURCE = Object.fromEntries(
  [
    'complexity',
    'max-depth',
    'max-lines',
    '@typescript-eslint/no-explicit-any',
    '@typescript-eslint/no-non-null-assertion',
    '@typescript-eslint/consistent-type-assertions',
    '@typescript-eslint/no-unnecessary-condition',
    '@typescript-eslint/no-unnecessary-type-assertion',
    '@typescript-eslint/no-unnecessary-boolean-literal-compare',
    '@typescript-eslint/prefer-nullish-coalescing',
    '@typescript-eslint/prefer-optional-chain',
    'unicorn/no-useless-fallback-in-spread',
  ].map((name) => [name, 'off']),
);
const PENDING_SPEC = Object.fromEntries(
  [
    'max-lines',
    'vitest/expect-expect',
    'vitest/no-standalone-expect',
    'vitest/max-expects',
    'vitest/no-conditional-in-test',
    'vitest/prefer-strict-equal',
    'vitest/prefer-called-with',
    'vitest/require-to-throw-message',
  ].map((name) => [name, 'off']),
);
const PENDING_SUPPRESSION = { '@eslint-community/eslint-comments/no-use': 'off' };
// Preset rules (tseslint/sonarjs recommended) with findings in this package, same contract.
const PENDING_PRESET = [
  '@typescript-eslint/no-unused-vars',
  'sonarjs/assertions-in-tests',
  'sonarjs/aws-s3-bucket-insecure-http',
  'sonarjs/aws-s3-bucket-public-access',
  'sonarjs/aws-s3-bucket-versioning',
  'sonarjs/aws-sqs-unencrypted-queue',
  'sonarjs/cognitive-complexity',
  'sonarjs/constructor-for-side-effects',
  'sonarjs/no-alphabetical-sort',
  'sonarjs/no-dead-store',
  'sonarjs/no-misleading-array-reverse',
  'sonarjs/no-nested-conditional',
  'sonarjs/no-nested-template-literals',
  'sonarjs/no-undefined-argument',
  'sonarjs/no-unused-vars',
  'sonarjs/prefer-regexp-exec',
  'sonarjs/publicly-writable-directories',
  'sonarjs/slow-regex',
  'sonarjs/todo-tag',
  'sonarjs/unused-import',
];
// PENDING: one stale `eslint-disable` directive (lib/); delete this line with it.
const REPORT_UNUSED_DISABLE_DIRECTIVES = QUALITY_BASELINE ? 'warn' : 'off';

export default tseslint.config(
  {
    ignores: [
      'frontend/**',
      'lambda/**',
      'plugins/**',
      'chrome-extension/**',
      'cdk.out/**',
      'dist/**',
      'coverage/**',
      'coverage_html/**',
      'node_modules/**',
      '.stryker-tmp/**',
      'reports/**',
      '**/*.d.ts',
      '**/*.js',
      '**/*.mjs',
    ],
  },
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  eslintComments.recommended,
  { rules: withPending(SUPPRESSION_RULES, PENDING_SUPPRESSION) },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.tools.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      unicorn,
      custom: { rules: { 'no-re-exports': noReExports } },
    },
    rules: withPending(SOURCE_RULES, PENDING_SOURCE),
  },
  {
    files: SPEC_FILES,
    plugins: { vitest },
    rules: withPending(SPEC_RULES, PENDING_SPEC),
  },
  {
    linterOptions: { reportUnusedDisableDirectives: REPORT_UNUSED_DISABLE_DIRECTIVES },
    rules: pendingPresetRules(PENDING_PRESET),
  },
);
