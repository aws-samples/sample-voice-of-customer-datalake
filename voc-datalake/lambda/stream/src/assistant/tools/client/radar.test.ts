/**
 * Radar write tools (save_radar_brands, run_radar_scan) and the `radar_brand`
 * argument of the connector tools: bounds, admin gating, card-only in plans,
 * and the brand prechecks against GET /radar/brands (as the caller).
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_CLIENT_TOOLS, packsForPage } from '../../contract.js';
import { CARD_ONLY_WRITE_TOOLS, planWriteTools } from '../../plan/schema.js';
import { appConnectorRecord, createdScraperRecord } from '../../plan/scraper-records.js';
import { clientToolLookup, fakeContext, fakeDeps, type FakeDeps } from '../test-fixtures.js';
import type { ClientToolDefinition } from '../../types.js';
import { normalizedBrandDomain, radarBrandKey } from './radar-schemas.js';

const admin = fakeContext('radar', {}, { isAdmin: true });
const user = fakeContext('radar');
const BRANDS = { 'GET /radar/brands': { brands: [{ key: 'example-air', label: 'Example Air', origin: 'profile' }, { key: 'acme-air', origin: 'list' }] } };
const SCRAPER = { id: 'acme', name: 'Acme', extraction_method: 'jsonld', base_url: 'https://www.acme.example/reviews' };
const WEB = { source: 'web_reviews', app_name: 'Acme Trustpilot', url: 'https://www.trustpilot.com/review/acme.example' };

/** The named client tool over `deps` (the brand list by default). */
const toolOf = (name: string, deps: FakeDeps = fakeDeps(BRANDS)): ClientToolDefinition => clientToolLookup(deps)(name);

const validated = (name: string, args: Record<string, unknown>) => toolOf(name).validate(args, admin);

describe('brand keys and domains as shared/radar_brands.py builds them', () => {
  it.each([['Acme Air', 'acme-air'], ['  Example Air ', 'example-air'], ['A&B+C', 'a-b-c'], ['Ünïcode Co.', 'ünïcode-co']])('%s → %s', (label, key) => {
    expect(radarBrandKey(label)).toBe(key);
  });

  it('strips scheme, path and www.', () => {
    expect(normalizedBrandDomain(' HTTPS://www.Acme.example/news ')).toBe('acme.example');
  });
});

describe('save_radar_brands argument bounds', () => {
  const brand = (label: string, domains?: string[]) => ({ label, ...(domains === undefined ? {} : { domains }) });
  it.each<[string, Record<string, unknown>, boolean]>([
    ['one brand with domains', { brands: [brand('Acme Air', ['acme.example'])] }, true],
    ['an empty list', { brands: [] }, true],
    ['25 brands', { brands: Array.from({ length: 25 }, (_, i) => brand(`B${i}`)) }, true],
    ['26 brands', { brands: Array.from({ length: 26 }, (_, i) => brand(`B${i}`)) }, false],
    ['two labels with one key', { brands: [brand('Acme Air'), brand('acme  air')] }, false],
    ['a 64-char label', { brands: [brand('a'.repeat(64))] }, true],
    ['a 65-char label', { brands: [brand('a'.repeat(65))] }, false],
    ['a label with a slash', { brands: [brand('a/b')] }, false],
    ['11 domains', { brands: [brand('A', Array.from({ length: 11 }, (_, i) => `d${i}.example`))] }, false],
    ['a domain that is no domain', { brands: [brand('A', ['localhost'])] }, false],
    ['an unknown brand key', { brands: [{ label: 'A', key: 'a' }] }, false],
  ])('%s → %s', (_label, args, expected) => {
    expect(validated('save_radar_brands', args).ok).toBe(expected);
  });

  it('normalises labels and domains into what the card shows (whitespace, www., duplicates)', () => {
    expect(validated('save_radar_brands', { brands: [{ label: ' Acme   Air ', domains: ['www.acme.example', 'https://acme.example/x'] }] }))
      .toStrictEqual({ ok: true, args: { brands: [{ label: 'Acme Air', domains: ['acme.example'] }] } });
  });

  it('summarises every brand with its key', () => {
    const tool = toolOf('save_radar_brands');
    expect(tool.summarize({ brands: [{ label: 'Acme Air' }] })).toBe('Save the Radar brand list: Acme Air (acme-air).');
    expect(tool.summarize({ brands: [] })).toBe('Clear the Radar brand list.');
  });
});

describe('radar_brand on the connector tools', () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ['create_scraper', { ...SCRAPER, radar_brand: 'acme-air' }, true],
    ['create_scraper', { ...SCRAPER, radar_brand: '' }, false],
    ['create_scraper', { ...SCRAPER, radar_brand: 'Acme Air' }, false],
    ['update_scraper', { scraper_id: 'acme', updates: { radar_brand: 'acme-air' } }, true],
    ['update_scraper', { scraper_id: 'acme', updates: { radar_brand: '' } }, true],
    ['create_app_connector', { ...WEB, radar_brand: 'example-air' }, true],
    ['create_app_connector', { ...WEB, radar_brand: '-x' }, false],
  ])('%s %j → %s', (name, args, expected) => {
    expect(validated(name, args).ok).toBe(expected);
  });

  it('refuses a key no brand has before any card, and passes a known or absent one', async () => {
    const deps = fakeDeps({ ...BRANDS, 'GET /scrapers': { scrapers: [{ id: 'acme' }] } });
    const create = toolOf('create_scraper', deps);
    expect(await create.precheck?.({ ...SCRAPER, id: 'new', radar_brand: 'ghost' }, admin)).toContain('no Radar brand has key "ghost"');
    expect(await create.precheck?.({ ...SCRAPER, id: 'new', radar_brand: 'example-air' }, admin)).toBeUndefined();
    expect(await toolOf('update_scraper', deps).precheck?.({ scraper_id: 'acme', updates: { radar_brand: '' } }, admin)).toBeUndefined();
    expect(await toolOf('create_app_connector', deps).precheck?.({ ...WEB, radar_brand: 'ghost' }, admin)).toContain('save_radar_brands');
  });

  it('reads the brand list as the caller through the proxy resource, and not at all without a brand', async () => {
    const deps = fakeDeps(BRANDS);
    await toolOf('create_app_connector', deps).precheck?.(WEB, admin);
    expect(deps.calls).toStrictEqual([]);
    await toolOf('create_app_connector', deps).precheck?.({ ...WEB, radar_brand: 'example-air' }, admin);
    expect(deps.calls).toStrictEqual([{
      call: { fn: 'radar', method: 'GET', path: '/radar/brands', resource: '/radar/{proxy+}', pathParameters: { proxy: 'brands' } }, sub: 'user-sub',
    }]);
  });

  it('a plan step saves radar_brand like the card: on scrapers as given, on connectors only when set', () => {
    expect(createdScraperRecord({ ...SCRAPER, radar_brand: 'example-air' })).toMatchObject({ radar_brand: 'example-air' });
    expect(appConnectorRecord({ ...WEB, radar_brand: 'example-air' })).toMatchObject({ radar_brand: 'example-air' });
    expect(appConnectorRecord(WEB)).not.toHaveProperty('radar_brand');
  });
});

describe('run_radar_scan', () => {
  it('refuses an unknown brand and an empty brand list before any card', async () => {
    expect(await toolOf('run_radar_scan').precheck?.({ brand: 'ghost' }, admin)).toContain('no Radar brand has key "ghost"');
    expect(await toolOf('run_radar_scan', fakeDeps({ 'GET /radar/brands': { brands: [] } })).precheck?.({}, admin))
      .toBe('no Radar brand is tracked yet. Propose save_radar_brands first.');
  });

  it('passes one known brand or every brand', async () => {
    const tool = toolOf('run_radar_scan');
    expect(await tool.precheck?.({ brand: 'example-air' }, admin)).toBeUndefined();
    expect(await tool.precheck?.({}, admin)).toBeUndefined();
    expect(tool.summarize({})).toBe('Scan every Radar brand for releases now.');
  });
});

describe('gating, packs and plans', () => {
  it.each(['save_radar_brands', 'run_radar_scan'])('%s is admin-only, card-only and never a plan step', (name) => {
    expect(ADMIN_ONLY_CLIENT_TOOLS).toContain(name);
    expect(CARD_ONLY_WRITE_TOOLS).toContain(name);
    expect(planWriteTools('scrapers')).not.toContain(name);
    expect(toolOf(name).validate({ brands: [] }, user)).toStrictEqual({ ok: false, error: `${name} is only available to administrators.` });
  });

  it('the Radar page loads core, insights and the scrapers pack (so "set up Radar" works there)', () => {
    expect(packsForPage('radar', true)).toStrictEqual(['core', 'insights', 'scrapers']);
    expect(packsForPage('radar', false)).toStrictEqual(['core', 'insights', 'scrapers']);
  });
});
