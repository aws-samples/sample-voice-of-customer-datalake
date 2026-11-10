import { describe, expect, it } from 'vitest';
import { CLIENT_TOOLS, PLAN_TOOL_NAMES, SERVER_TOOLS, TOOL_PACKS } from '../contract.js';
import { buildCatalogue } from '../tools/catalogue.js';
import { fakeDeps } from '../tools/test-fixtures.js';
import { canonicalJson, canonicalWriteText, CanonicalJsonError } from './canonical.js';
import { planContractJson } from './contract-json.js';
import { canonicalWriteFingerprint } from './fingerprint.js';
import { FINGERPRINT_CASES } from './plan-fixtures.js';
import { FREE_TEXT_FIELDS, NEVER_PREAPPROVABLE_TOOLS, PLAN_ID_RE, planWriteTools } from './schema.js';

/** The committed text of `lambda/shared/plan_contract.json` (stream-only: the SPA's Vite denies `?raw` outside its root). */
const COMMITTED_PLAN_CONTRACT = Object.values(
  import.meta.glob<string>('../../../../shared/plan_contract.json', { eager: true, query: '?raw', import: 'default' }),
).join('');
const ALL_CLIENT = new Set<string>(TOOL_PACKS.flatMap((pack) => CLIENT_TOOLS[pack]));
const ALL_WRITE = new Set(TOOL_PACKS.flatMap((pack) => planWriteTools(pack)));
const PLANNED_SERVER: string[] = Object.values<readonly string[]>(PLAN_TOOL_NAMES.server).flat();
const PLANNED_CLIENT: string[] = Object.values<readonly string[]>(PLAN_TOOL_NAMES.client).flat();

describe('plan contract constants', () => {
  it('recognises plan ids and nothing else', () => {
    expect(PLAN_ID_RE.test('pl_0123456789ab')).toBe(true);
    expect(['ag_0123456789ab', 'pl_0123456789AB', 'pl_0123456789abc'].map((id) => PLAN_ID_RE.test(id))).toStrictEqual([false, false, false]);
  });

  it('offers the built plan-mode client tools as plan writes of their pack', () => {
    expect(planWriteTools('scrapers')).toContain('run_source');
    expect(planWriteTools('project')).toContain('build_prototype');
  });

  it('never offers the plan control tools as a plan write', () => {
    expect(ALL_WRITE.has('propose_plan')).toBe(false);
    expect(ALL_WRITE.has('cancel_plan')).toBe(false);
  });

  it('keeps planned names out of the implemented tool lists until a track builds them', () => {
    const implemented = new Set<string>(TOOL_PACKS.flatMap((pack) => [...SERVER_TOOLS[pack], ...CLIENT_TOOLS[pack]]));
    expect([...PLANNED_SERVER, ...PLANNED_CLIENT].filter((name) => implemented.has(name))).toStrictEqual([]);
  });

  it('has moved every plan-mode tool into the implemented lists', () => {
    expect([...PLANNED_SERVER, ...PLANNED_CLIENT, ...PLAN_TOOL_NAMES.adminOnlyClient]).toStrictEqual([]);
  });

  it('names only real write tools as never pre-approvable', () => {
    expect(NEVER_PREAPPROVABLE_TOOLS.filter((name) => !ALL_CLIENT.has(name))).toStrictEqual([]);
  });

  it('lists free-text fields only for plan write tools', () => {
    expect(Object.keys(FREE_TEXT_FIELDS).filter((tool) => !ALL_WRITE.has(tool))).toStrictEqual([]);
  });
});

describe('FREE_TEXT_FIELDS against the real tool schemas', () => {
  const tools = buildCatalogue(fakeDeps());
  const schemaOf = (name: string) => tools.find((tool) => tool.kind === 'client' && tool.name === name);
  const cases = Object.entries(FREE_TEXT_FIELDS).flatMap(([tool, paths]) => paths.map((path) => [tool, path] as const))
    .filter(([tool]) => schemaOf(tool) !== undefined);

  it.each(cases)('%s.%s is a string field of the tool', (tool, path) => {
    const definition = schemaOf(tool);
    const schema = definition?.kind === 'client' ? definition.argsSchema : undefined;
    const issues = schema?.safeParse(nestedArgs(path, 42)).error?.issues ?? [];
    expect(issues.some((issue) => issue.path.join('.') === path && issue.code === 'invalid_type')).toBe(true);
  });
});

/** `{a: {b: value}}` for `a.b` — plus the ids a tool requires, so only the free field can fail on type. */
function nestedArgs(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  const leaf = parts.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
  return typeof leaf === 'object' && leaf !== null ? { project_id: 'p1', persona_id: 'q1', ...leaf } : {};
}

describe('canonical JSON and the write fingerprint', () => {
  it('loads the shared fingerprint cases (positive control)', () => {
    expect(FINGERPRINT_CASES.length).toBeGreaterThanOrEqual(5);
  });

  it.each(FINGERPRINT_CASES.map((entry) => [entry.tool, entry] as const))('%s matches the shared canonical text and sha256', (_tool, entry) => {
    expect(canonicalWriteText(entry.tool, entry.args)).toBe(entry.canonical);
    expect(canonicalWriteFingerprint(entry.tool, entry.args)).toBe(entry.sha256);
  });

  it('is independent of key order', () => {
    expect(canonicalWriteFingerprint('t', { b: 1, a: { d: 2, c: 3 } })).toBe(canonicalWriteFingerprint('t', { a: { c: 3, d: 2 }, b: 1 }));
  });

  it('refuses values with no canonical form', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson('\uDC00')).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(() => 1)).toThrow(CanonicalJsonError);
  });
});

describe('lambda/shared/plan_contract.json', () => {
  it('equals what the TypeScript contract generates (regenerate: see contract-json.ts)', () => {
    expect(COMMITTED_PLAN_CONTRACT).toBe(planContractJson());
  });
});
