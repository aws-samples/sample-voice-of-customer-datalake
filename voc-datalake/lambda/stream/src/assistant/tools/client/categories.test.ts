/**
 * save_categories (the categories-first rule's save): its argument bounds against lambda/shared/category_config.py,
 * the stored name it makes of a label (the categories editor's), the precheck against the configured categories (as
 * the caller), and its gating: administrators only, the `core` pack, card-only, never a plan step.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_CLIENT_TOOLS, CLIENT_TOOLS, packsForPage } from '../../contract.js';
import { CARD_ONLY_WRITE_TOOLS, planWriteTools } from '../../plan/schema.js';
import { clientToolLookup, fakeContext, fakeDeps, type FakeDeps } from '../test-fixtures.js';
import { CATEGORY_PROPOSAL_LIMITS, categorySlug, foldedLabel, isCategoryLabel, repeatedSlugs, saveCategoriesArgsSchema } from './category-schemas.js';

const admin = fakeContext('scrapers', {}, { isAdmin: true });
const user = fakeContext('scrapers');
const CONFIG = (names: string[]) => ({ 'GET /settings/categories': { categories: names.map((name) => ({ name, description: name })) } });
const toolOf = (deps: FakeDeps = fakeDeps(CONFIG([]))) => clientToolLookup(deps)('save_categories');
const category = (label: string, subcategories: string[] = ['One', 'Two', 'Three'], product?: string) =>
  ({ label, subcategories, ...(product === undefined ? {} : { product }) });

const PYTHON = readFileSync(join(__dirname, '../../../../../shared/category_config.py'), 'utf8');
const pythonInt = (name: string) => Number(new RegExp(`^${name}: Final = (\\d+)`, 'm').exec(PYTHON)?.[1]);

describe('the bounds the categories route holds (shared/category_config.py)', () => {
  it('a label is at most a name long and a product at most MAX_PRODUCT_CHARS', () => {
    expect(CATEGORY_PROPOSAL_LIMITS.maxLabelChars).toBe(pythonInt('MAX_NAME_CHARS'));
    expect(CATEGORY_PROPOSAL_LIMITS.maxProductChars).toBe(pythonInt('MAX_PRODUCT_CHARS'));
    // (a whole proposal stays well inside the route's own caps)
    expect(CATEGORY_PROPOSAL_LIMITS.maxCategories).toBeLessThanOrEqual(pythonInt('MAX_CATEGORIES'));
    expect(CATEGORY_PROPOSAL_LIMITS.maxSubcategories).toBeLessThanOrEqual(pythonInt('MAX_SUBCATEGORIES'));
  });

  it.each([
    ['Delivery', 'delivery'], ['  Late   delivery ', 'late_delivery'], ['Zahlung & Rechnung', 'zahlung_&_rechnung'],
  ])('%j is stored as %j, as the categories editor stores it', (label, slug) => {
    expect(categorySlug(foldedLabel(label))).toBe(slug);
  });

  it('finds each label whose stored name an earlier one has (the route refuses a name twice)', () => {
    expect(repeatedSlugs(['Delivery', 'delivery', 'Late  parcel', 'late parcel', 'Returns'])).toStrictEqual([1, 3]);
  });

  it.each([
    ['Delivery', true], ['x'.repeat(64), true], ['x'.repeat(65), false], ['Bills #1', false], ['*', false], ['', false],
    // (lower-casing "İ" makes two code points: 64 of them make a name of 128, which the route refuses)
    ['İ'.repeat(64), false],
  ])('the label %j is one the route takes: %s', (label, ok) => {
    expect(isCategoryLabel(foldedLabel(label))).toBe(ok);
  });
});

describe('save_categories arguments', () => {
  const validated = (args: Record<string, unknown>) => toolOf().validate(args, admin);

  it('normalises labels and drops a blank product', () => {
    expect(validated({ categories: [category('  Delivery  ', ['Late   delivery'], ' ')] }))
      .toStrictEqual({ ok: true, args: { categories: [{ label: 'Delivery', subcategories: ['Late delivery'] }] } });
  });

  it.each<[string, Record<string, unknown>, boolean]>([
    ['one category', { categories: [category('Delivery')] }, true],
    ['ten categories', { categories: Array.from({ length: 10 }, (_, i) => category(`C${i}`)) }, true],
    ['eleven categories', { categories: Array.from({ length: 11 }, (_, i) => category(`C${i}`)) }, false],
    ['none', { categories: [] }, false],
    ['six subcategories', { categories: [category('Delivery', ['a', 'b', 'c', 'd', 'e', 'f'])] }, false],
    ['no subcategories', { categories: [category('Delivery', [])] }, true],
    ['two categories with one name', { categories: [category('Delivery'), category('delivery ')] }, false],
    ['two subcategories with one name', { categories: [category('Delivery', ['Late', 'LATE'])] }, false],
    ['a "#" in a subcategory', { categories: [category('Delivery', ['#late'])] }, false],
    ['a product over 120', { categories: [category('Delivery', [], 'p'.repeat(121))] }, false],
    ['an unknown key', { categories: [{ ...category('Delivery'), description: 'Parcels' }] }, false],
  ])('%s: valid %s', (_name, args, ok) => {
    expect(validated(args).ok).toBe(ok);
    expect(saveCategoriesArgsSchema.safeParse(args).success).toBe(ok);
  });

  it('summarizes what it adds', () => {
    const result = validated({ categories: [category('Delivery'), category('Billing', ['Refunds'])] });
    expect(result.ok && toolOf().summarize(result.args)).toBe('Add 2 categories: Delivery (3 subcategories), Billing (1 subcategory).');
  });
});

describe('the precheck reads the configured categories as the caller', () => {
  it('lets a set with new names through', async () => {
    const deps = fakeDeps(CONFIG(['billing']));
    expect(await toolOf(deps).precheck?.({ categories: [category('Delivery')] }, admin)).toBeUndefined();
    expect(deps.calls.map(({ call }) => `${call.method} ${call.path}`)).toStrictEqual(['GET /settings/categories']);
  });

  it('refuses a category configured already (it only adds)', async () => {
    const refusal = await toolOf(fakeDeps(CONFIG(['Delivery']))).precheck?.({ categories: [category('Delivery'), category('Billing')] }, admin);
    expect(refusal).toContain("categories 'delivery' are configured already: save_categories only adds new ones");
  });

  it('refuses when the categories cannot be read (nothing unverified is proposed)', async () => {
    const unreadable = fakeDeps({ 'GET /settings/categories': { categories: [], error: 'Failed to retrieve categories' } });
    await expect(toolOf(unreadable).precheck?.({ categories: [category('Delivery')] }, admin)).rejects.toThrow('could not be read');
  });
});

describe('gating, packs and plans', () => {
  it('is an administrator’s core write on every page, card-only and never a plan step', () => {
    const lists = { core: CLIENT_TOOLS.core, adminOnly: ADMIN_ONLY_CLIENT_TOOLS, cardOnly: CARD_ONLY_WRITE_TOOLS };
    expect(Object.values(lists).map((list) => list.some((name) => name === 'save_categories'))).toStrictEqual([true, true, true]);
    expect([planWriteTools('core').includes('save_categories'), packsForPage('project', true).includes('core')]).toStrictEqual([false, true]);
    expect(toolOf().validate({ categories: [category('Delivery')] }, user))
      .toStrictEqual({ ok: false, error: 'save_categories is only available to administrators.' });
  });

  it('tells the model it adds, leaves configured ones alone and lets the card edit the set', () => {
    const description = toolOf().spec.toolSpec?.description ?? '';
    expect(description).toContain('ADDED to the categories already configured');
    expect(description).toContain('The approval card lets the user edit the set before approving');
    expect(description).toContain('call list_categories again');
  });
});
