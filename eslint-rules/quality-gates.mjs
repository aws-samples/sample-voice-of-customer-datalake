/**
 * The quality-gate rule set every TypeScript package's eslint.config.js shares (dead code,
 * logic that says more than it does, floating promises, tests that do not test, suppressions).
 *
 * This file imports no plugin: each package has its own node_modules (and eslint major), so a
 * package config imports its plugins and passes them in. Rule NAMES and settings live here once.
 *
 * Pending rules: a package lists, in its own config, the rules below whose pre-existing findings
 * are not fixed yet, each with the setting the package enforced before (or 'off'). A normal run
 * uses that setting, so `npm run lint` stays the gate; `QUALITY_BASELINE=1` turns every pending
 * rule on at 'warn' with the target setting, which is how `npm run quality:baseline` counts what
 * is left. An entry is deleted by the change that brings its count to zero; never add one back.
 */

export const QUALITY_BASELINE = process.env.QUALITY_BASELINE === '1';

/** Rules for production source files. */
export const SOURCE_RULES = {
  // size and shape
  complexity: ['error', 12],
  'max-depth': ['error', 3],
  'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
  'prefer-const': 'error',
  'no-var': 'error',
  // no escape hatches
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-non-null-assertion': 'error',
  // Stricter than the brief's `assertionStyle: 'as'`: both packages already banned every assertion.
  '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
  // imports that do not import
  'custom/no-re-exports': 'error',
  // logic that says more than it does
  '@typescript-eslint/no-unnecessary-condition': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
  '@typescript-eslint/no-unnecessary-template-expression': 'error',
  '@typescript-eslint/no-redundant-type-constituents': 'error',
  '@typescript-eslint/prefer-nullish-coalescing': 'error',
  '@typescript-eslint/prefer-optional-chain': 'error',
  '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
  'no-else-return': 'error',
  'no-lonely-if': 'error',
  'no-useless-return': 'error',
  'unicorn/no-useless-spread': 'error',
  'unicorn/no-useless-fallback-in-spread': 'error',
  // promises: awaited, returned, caught, or explicitly `void`ed
  '@typescript-eslint/no-floating-promises': 'error',
  // `attributes: false`: React discards an event handler's return value, so an async JSX handler is fine.
  '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
};

/** Rules for spec files (`*.test.ts(x)`, `*.spec.ts(x)`). */
export const SPEC_RULES = {
  // The streaming Lambda's spec ceiling before this shared set existed; its largest spec
  // (src/tools/search-feedback.test.ts) sits at exactly 700. Lower it as specs are split; never raise it.
  'max-lines': ['error', { max: 700, skipBlankLines: true, skipComments: true }],
  // a test that asserts nothing passes whatever the code does
  'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expect*'] }],
  'vitest/valid-expect': ['error', { maxArgs: 2 }],
  'vitest/no-standalone-expect': 'error',
  'vitest/max-expects': ['error', { max: 4 }],
  'vitest/no-conditional-in-test': 'error',
  'vitest/no-conditional-expect': 'error',
  'vitest/no-identical-title': 'error',
  'vitest/no-disabled-tests': 'error',
  'vitest/no-focused-tests': 'error',
  'vitest/no-commented-out-tests': 'error',
  'vitest/prefer-strict-equal': 'error',
  'vitest/prefer-called-with': 'error',
  'vitest/require-to-throw-message': 'error',
};

/** No suppression comments at all: fix the finding. */
export const SUPPRESSION_RULES = {
  '@eslint-community/eslint-comments/no-use': ['error', { allow: [] }],
};

export const SPEC_FILES = ['**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/*.test.tsx'];

/**
 * @typedef {import('eslint').Linter.RuleEntry} RuleEntry
 * @typedef {Record<string, RuleEntry>} RuleSet
 */

/**
 * @param {RuleEntry} setting
 * @returns {RuleEntry}
 */
function asWarning(setting) {
  return Array.isArray(setting) ? ['warn', ...setting.slice(1)] : 'warn';
}

/**
 * `rules` with every rule named in `pending` replaced: by the package's previous setting in a normal
 * run, or by the target setting at 'warn' under QUALITY_BASELINE=1. Throws on a pending name the
 * rule set does not contain, so a stale entry cannot outlive the rule it pends.
 *
 * @param {RuleSet} rules
 * @param {RuleSet} pending
 * @returns {RuleSet}
 */
export function withPending(rules, pending) {
  const result = { ...rules };
  for (const [name, previous] of Object.entries(pending)) {
    const target = rules[name];
    if (target === undefined) {
      throw new Error(`quality-gates: pending rule '${name}' is not in this rule set`);
    }
    result[name] = QUALITY_BASELINE ? asWarning(target) : previous;
  }
  return result;
}

/**
 * For a rule that comes from a preset (tseslint/sonarjs recommended) rather than this file: the
 * overrides that switch a pending rule off in a normal run, and nothing under QUALITY_BASELINE, so
 * the preset's own setting applies and the baseline counts its findings.
 *
 * @param {string[]} names
 * @returns {RuleSet}
 */
export function pendingPresetRules(names) {
  return QUALITY_BASELINE ? {} : Object.fromEntries(names.map((name) => [name, 'off']));
}
