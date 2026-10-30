// ESLint for the CDK app (bin/, lib/, scripts/). The frontend and the streaming Lambda have their
// own configs and node_modules, so they are ignored here.
import tseslint from 'typescript-eslint';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import vitest from '@vitest/eslint-plugin';
import noReExports from '../eslint-rules/no-re-exports.mjs';
import {
  SOURCE_RULES,
  SPEC_FILES,
  SPEC_RULES,
  SUPPRESSION_RULES,
  SWALLOWED_REJECTION_SELECTORS,
  pendingPresetRules,
  withPending,
} from '../eslint-rules/quality-gates.mjs';

// Rules of the shared quality-gate set (../eslint-rules/quality-gates.mjs) whose findings in this
// package are not fixed yet. The CDK app had no ESLint before, so each previous setting is 'off'.
// Delete an entry in the change that brings its count to zero; never add one back.
const PENDING_SOURCE = {};
const PENDING_SPEC = {};
const PENDING_SUPPRESSION = {};
// Preset rules (tseslint/sonarjs recommended) with findings in this package, same contract.
const PENDING_PRESET = [];

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
    rules: {
      ...withPending(SOURCE_RULES, PENDING_SOURCE),
      'no-restricted-syntax': ['error', ...SWALLOWED_REJECTION_SELECTORS],
    },
  },
  {
    // Added 5.49 wave, owner-approved: no hardcoded `arn:aws:` partition in production CDK code, so a
    // template also deploys to aws-cn / aws-us-gov. Build ARNs from `Stack.of(this).partition` (a literal
    // for a concrete region under @aws-cdk/core:enablePartitionLiterals) or `cdk.Aws.PARTITION`.
    // Limit: only a string or template part that STARTS with `arn:aws:` is caught.
    files: ['**/*.ts'],
    ignores: [...SPEC_FILES, 'lib/test-support/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...SWALLOWED_REJECTION_SELECTORS,
        { selector: 'Literal[value=/^arn:aws:/]', message: 'Hardcoded ARN partition: build it from the stack partition.' },
        {
          selector: 'TemplateElement[value.raw=/^arn:aws:/]',
          message: 'Hardcoded ARN partition: build it from the stack partition.',
        },
      ],
    },
  },
  {
    files: SPEC_FILES,
    plugins: { vitest },
    rules: withPending(SPEC_RULES, PENDING_SPEC),
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: pendingPresetRules(PENDING_PRESET),
  },
);
