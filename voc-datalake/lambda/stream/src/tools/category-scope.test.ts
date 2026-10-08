import { describe, expect, it } from 'vitest';
import { admitsItem, categoryScopeResponseSchema, toCategoryScope } from './category-scope.js';

const BASE = { all: true, categories: [], sources_all: false, sources: [], sources_denied: [] };

function scopeOf(body: Record<string, unknown>) {
  return toCategoryScope(categoryScopeResponseSchema.parse({ ...BASE, ...body }));
}

const TICKET = { category: 'billing', source_platform: 'support_tickets' };
const REVIEW = { category: 'billing', source_platform: 'webscraper' };

describe('toCategoryScope and admitsItem', () => {
  it('applies an allow rule: exactly the granted sources', () => {
    const scope = scopeOf({ source_rule: 'allow', sources: ['support_tickets'] });
    expect([admitsItem(scope, TICKET), admitsItem(scope, REVIEW), scope.all]).toStrictEqual([true, false, false]);
  });

  it('applies a deny rule: everything but the restricted sources', () => {
    const scope = scopeOf({ source_rule: 'deny', sources_denied: ['support_tickets'] });
    expect([admitsItem(scope, TICKET), admitsItem(scope, REVIEW)]).toStrictEqual([false, true]);
  });

  it.each([
    ['missing', {}],
    ['unknown', { source_rule: 'maybe' }],
    ['deny without a readable list', { source_rule: 'deny', sources_denied: 'support_tickets' }],
  ])('fails closed when sources_all is false and the rule is %s', (_label, body) => {
    const scope = scopeOf(body);
    expect([scope.sourceRule, admitsItem(scope, REVIEW), admitsItem(scope, TICKET)]).toStrictEqual(['none', false, false]);
  });

  it('needs category-all AND source-all for the unrestricted short-cut', () => {
    const categoryOnly = scopeOf({ all: false, categories: ['billing'], sources_all: true });
    expect([categoryOnly.all, admitsItem(categoryOnly, TICKET), admitsItem(categoryOnly, { category: 'x' })])
      .toStrictEqual([false, true, false]);
    expect(scopeOf({ sources_all: true }).all).toBe(true);
  });

  it('refuses a body that does not say whether a source is hidden', () => {
    expect(categoryScopeResponseSchema.safeParse({ all: true, categories: [] }).success).toBe(false);
  });

  it('reads a malformed sources list as no grants at all', () => {
    const scope = scopeOf({ source_rule: 'allow', sources: 'support_tickets' });
    expect([[...scope.sources], admitsItem(scope, TICKET)]).toStrictEqual([[], false]);
  });

  // A category literally named '' still admits no uncategorised row: restricted
  // callers never see an item without a category, whatever the list holds.
  it.each([
    ['an empty category', { category: '', source_platform: 'webscraper' }, false],
    ['a missing category', { source_platform: 'webscraper' }, false],
    ['a granted category', REVIEW, true],
  ])('a restricted category rule hides %s', (_label, item, expected) => {
    const scope = scopeOf({ all: false, categories: ['', 'billing'], sources_all: true });
    expect(admitsItem(scope, item)).toBe(expected);
  });

  // A row without source_platform is looked up as '' — so an allow-list naming ''
  // admits it and a deny-list naming '' hides it.
  it.each([
    ['allow', { source_rule: 'allow', sources: [''] }, true],
    ['deny', { source_rule: 'deny', sources_denied: [''] }, false],
  ])('a %s rule reads a missing source as the empty name', (_label, body, expected) => {
    expect(admitsItem(scopeOf(body), { category: 'billing' })).toBe(expected);
  });
});
