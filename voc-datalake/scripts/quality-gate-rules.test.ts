/**
 * Tests for the repo-root ESLint gate code (../../eslint-rules/): these files decide what every
 * TypeScript package may merge, so they are gated like any other code. They live here because this
 * package has eslint installed; the repo root has no node_modules of its own for it.
 */
import { RuleTester, type Linter } from 'eslint';
import { afterEach, describe, expect, it, vi } from 'vitest';
import noReExports from '../../eslint-rules/no-re-exports.mjs';

const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });

/** An invalid case where `name`, an imported binding, is re-exported. */
function reExportImport(code: string, name: string) {
  return { code, errors: [{ messageId: 'reExportImport', data: { name } }] };
}

describe('custom/no-re-exports', () => {
  ruleTester.run('no-re-exports', noReExports, {
    valid: [
      'export const declared = 1;',
      'const local = 1; export { local };',
      'const local = 1; export { local as renamed };',
      'export function declared() {}',
      'export default function declared() {}',
      'export default class {}',
      'export default 42;',
      // an imported value used to build a new one is not a re-export
      "import value from 'm'; const derived = value + 1; export { derived };",
      // a local binding that shadows an import is not the import
      "import shadowed from 'm'; export function f() { const shadowed = 1; return shadowed; }",
      "import value from 'm'; export const used = value;",
    ],
    invalid: [
      { code: "export * from './m';", errors: [{ messageId: 'reExportFrom', data: { source: './m' } }] },
      { code: "export * as ns from './m';", errors: [{ messageId: 'reExportFrom' }] },
      { code: "export { a } from './m';", errors: [{ messageId: 'reExportFrom' }] },
      { code: "export { default } from './m';", errors: [{ messageId: 'reExportFrom' }] },
      reExportImport("import a from 'm'; export { a };", 'a'),
      reExportImport("import { a as b } from 'm'; export { b as c };", 'b'),
      { code: "import * as ns from 'm'; export { ns };", errors: [{ messageId: 'reExportImport' }] },
      reExportImport("import a from 'm'; const own = 1; export { a, own };", 'a'),
      reExportImport("import a from 'm'; export default a;", 'a'),
    ],
  });
});

// QUALITY_BASELINE is read when the module loads, so each mode gets a fresh import.
async function loadQualityGates(baseline: '0' | '1') {
  vi.stubEnv('QUALITY_BASELINE', baseline);
  vi.resetModules();
  return import('../../eslint-rules/quality-gates.mjs');
}

const RULES: Record<string, Linter.RuleEntry> = {
  'max-lines': ['error', { max: 400 }],
  'no-var': 'error',
  untouched: 'error',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('withPending in a normal run', () => {
  it("replaces each pending rule by the package's previous setting and keeps the rest", async () => {
    const { withPending } = await loadQualityGates('0');

    expect(withPending(RULES, { 'max-lines': ['error', { max: 600 }], 'no-var': 'off' })).toStrictEqual({
      'max-lines': ['error', { max: 600 }],
      'no-var': 'off',
      untouched: 'error',
    });
  });

  it('does not mutate the shared rule set', async () => {
    const { withPending } = await loadQualityGates('0');
    const rules = { ...RULES };

    withPending(rules, { 'no-var': 'off' });

    expect(rules).toStrictEqual(RULES);
  });

  it('throws on a pending name the rule set does not contain, so a stale entry cannot linger', async () => {
    const { withPending } = await loadQualityGates('0');

    expect(() => withPending(RULES, { 'no-such-rule': 'off' })).toThrow(
      "quality-gates: pending rule 'no-such-rule' is not in this rule set",
    );
  });
});

describe('withPending under QUALITY_BASELINE=1', () => {
  it('turns each pending rule on at warn with the target options, ignoring the previous setting', async () => {
    const { withPending, QUALITY_BASELINE } = await loadQualityGates('1');

    expect(QUALITY_BASELINE).toBe(true);
    expect(withPending(RULES, { 'max-lines': 'off', 'no-var': 'off' })).toStrictEqual({
      'max-lines': ['warn', { max: 400 }],
      'no-var': 'warn',
      untouched: 'error',
    });
  });

  it('still throws on a stale pending name', async () => {
    const { withPending } = await loadQualityGates('1');

    expect(() => withPending(RULES, { 'no-such-rule': 'off' })).toThrow("pending rule 'no-such-rule'");
  });
});

describe('pendingPresetRules', () => {
  it('switches each pending preset rule off in a normal run', async () => {
    const { pendingPresetRules, QUALITY_BASELINE } = await loadQualityGates('0');

    expect(QUALITY_BASELINE).toBe(false);
    expect(pendingPresetRules(['sonarjs/todo-tag', 'no-unused-vars'])).toStrictEqual({
      'sonarjs/todo-tag': 'off',
      'no-unused-vars': 'off',
    });
  });

  it("overrides nothing under QUALITY_BASELINE=1, so the preset's own setting is counted", async () => {
    const { pendingPresetRules } = await loadQualityGates('1');

    expect(pendingPresetRules(['sonarjs/todo-tag'])).toStrictEqual({});
  });
});

// The size ceilings are human-owned (see the notice at the top of eslint-rules/quality-gates.mjs).
// If this fails, do NOT edit the numbers here or there: split the offending file, or ask the owner.
describe('fixed max-lines ceilings (human approval required to change)', () => {
  it('caps production source files at 400 lines', async () => {
    const { SOURCE_RULES } = await import('../../eslint-rules/quality-gates.mjs');
    expect(SOURCE_RULES['max-lines']).toStrictEqual(['error', { max: 400, skipBlankLines: true, skipComments: true }]);
  });

  it('caps spec files at 750 lines', async () => {
    const { SPEC_RULES } = await import('../../eslint-rules/quality-gates.mjs');
    expect(SPEC_RULES['max-lines']).toStrictEqual(['error', { max: 750, skipBlankLines: true, skipComments: true }]);
  });
});
