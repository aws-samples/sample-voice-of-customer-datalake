/**
 * The user's on-screen filters as a floor (docs/assistant-chat-scope.md): parsing the page / panel
 * vocabulary, intersecting the two, and admitting a review.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_FLOOR, admitsFloor, describeFloor, floorForRun, floorFromFilters, intersectFloors, isEmptyFloor, readLimitForRun,
} from './feedback-floor.js';
import { CHAT_SCOPE_MAX_ITEMS } from '../../contract.js';

const ITEM = {
  source_platform: 'webscraper',
  category: 'delivery',
  subcategory: 'late',
  sentiment_label: 'negative',
  source_channel: 'email',
  tags: ['VIP'],
  dimensions: { product: 'App' },
  rating: 2,
  urgency: 'high',
  original_text: 'The parcel came late',
};

describe('floorFromFilters', () => {
  it('is no floor without filters', () => {
    expect(floorFromFilters(undefined)).toStrictEqual(NO_FLOOR);
    expect(isEmptyFloor(floorFromFilters({}))).toBe(true);
  });

  it('splits comma lists for source / category / subcategory / sentiment, never for channel or tag', () => {
    const floor = floorFromFilters({ category: 'delivery, billing ,delivery', channel: 'a,b', tag: 'x,y' });
    expect(floor.lists).toStrictEqual({ category: ['delivery', 'billing'], channel: ['a,b'], tag: ['x,y'] });
  });

  it('reads dims alternatives and ~unset, lower-cased, and fails a malformed pair closed', () => {
    expect(floorFromFilters({ dims: 'product:App|web,module:~unset' }).dims)
      .toStrictEqual({ product: ['app', 'web'], module: ['~unset'] });
    const broken = floorFromFilters({ dims: 'nonsense' });
    expect(broken.dims).toStrictEqual({ nonsense: [] });
    expect(admitsFloor(broken, ITEM)).toBe(false);
  });

  it('reads rating the way the page does: at least, at most with rating_dir=below, else any', () => {
    expect(floorFromFilters({ rating: '4' }).ratingMin).toBe(4);
    expect(floorFromFilters({ rating: '2', rating_dir: 'below' }).ratingMax).toBe(2);
    expect(isEmptyFloor(floorFromFilters({ rating: '9' }))).toBe(true);
  });

  it('reads urgent=1 / true, and q as a search text', () => {
    expect(floorFromFilters({ urgent: '1' }).urgent).toBe(true);
    expect(floorFromFilters({ urgent: 'true' }).urgent).toBe(true);
    expect(floorFromFilters({ urgent: '0' }).urgent).toBe(false);
    expect(floorFromFilters({ q: ' late ' }).queries).toStrictEqual(['late']);
  });

  it('ignores resolved and similarity (grouping, not which reviews)', () => {
    expect(isEmptyFloor(floorFromFilters({ resolved: 'show', similarity: '0.8' }))).toBe(true);
  });
});

describe('intersectFloors / floorForRun', () => {
  it('intersects the page filters with the chat panel scope', () => {
    const floor = floorForRun(
      { kind: 'categories', path: '/categories', filters: { category: 'delivery,billing', rating: '2' } },
      { scope: { filters: { category: 'billing,pricing', rating: '4', urgent: '1' } } },
    );
    expect(floor.lists.category).toStrictEqual(['billing']);
    expect(floor.ratingMin).toBe(4);
    expect(floor.urgent).toBe(true);
  });

  it('two floors that do not overlap admit nothing', () => {
    const floor = intersectFloors(floorFromFilters({ source: 'a' }), floorFromFilters({ source: 'b' }));
    expect(floor.lists.source).toStrictEqual([]);
    expect(admitsFloor(floor, { ...ITEM, source_platform: 'a' })).toBe(false);
  });

  it('intersects dims per key and keeps the tighter rating bounds', () => {
    const floor = intersectFloors(
      floorFromFilters({ dims: 'product:app|web', rating: '2', rating_dir: 'below' }),
      floorFromFilters({ dims: 'product:web,module:x', rating: '1', rating_dir: 'below' }),
    );
    expect(floor.dims).toStrictEqual({ product: ['web'], module: ['x'] });
    expect(floor.ratingMax).toBe(1);
  });
});

describe('admitsFloor', () => {
  it('admits everything without a floor', () => {
    expect(admitsFloor(NO_FLOOR, {})).toBe(true);
  });

  it('ANDs across fields and ORs within one', () => {
    expect(admitsFloor(floorFromFilters({ source: 'webscraper,other', category: 'delivery' }), ITEM)).toBe(true);
    expect(admitsFloor(floorFromFilters({ source: 'webscraper', category: 'billing' }), ITEM)).toBe(false);
    expect(admitsFloor(floorFromFilters({ subcategory: 'late' }), ITEM)).toBe(true);
    expect(admitsFloor(floorFromFilters({ subcategory: 'early' }), ITEM)).toBe(false);
  });

  it('matches the stored usefulness band, any of a comma list', () => {
    const rated = { ...ITEM, usefulness: 'high' };
    expect(admitsFloor(floorFromFilters({ usefulness: 'high,medium' }), rated)).toBe(true);
    expect(admitsFloor(floorFromFilters({ usefulness: 'low' }), rated)).toBe(false);
  });

  it('admits a review without a band only to `unrated`', () => {
    expect(admitsFloor(floorFromFilters({ usefulness: 'high' }), ITEM)).toBe(false);
    expect(admitsFloor(floorFromFilters({ usefulness: 'unrated' }), ITEM)).toBe(true);
    expect(admitsFloor(floorFromFilters({ usefulness: 'unrated' }), { ...ITEM, usefulness: 'high' })).toBe(false);
  });

  it('matches tags and dims ignoring case, ~unset for a missing value', () => {
    expect(admitsFloor(floorFromFilters({ tag: 'vip', dims: 'product:app' }), ITEM)).toBe(true);
    expect(admitsFloor(floorFromFilters({ dims: 'module:~unset' }), ITEM)).toBe(true);
    expect(admitsFloor(floorFromFilters({ dims: 'module:x' }), ITEM)).toBe(false);
  });

  it('refuses an unrated review once a rating bound is set, and a non-high one when urgent', () => {
    expect(admitsFloor(floorFromFilters({ rating: '1' }), { ...ITEM, rating: null })).toBe(false);
    expect(admitsFloor(floorFromFilters({ rating: '3', rating_dir: 'below' }), ITEM)).toBe(true);
    expect(admitsFloor(floorFromFilters({ urgent: '1' }), { ...ITEM, urgency: 'low' })).toBe(false);
  });

  it('needs every search text in the review', () => {
    expect(admitsFloor(floorFromFilters({ q: 'LATE' }), ITEM)).toBe(true);
    expect(admitsFloor(floorFromFilters({ q: 'refund' }), ITEM)).toBe(false);
  });
});

describe('readLimitForRun / describeFloor', () => {
  it('caps a read only when the chat panel sent a scope (default and maximum 1000)', () => {
    expect(readLimitForRun({})).toBeUndefined();
    expect(readLimitForRun({ scope: {} })).toBe(CHAT_SCOPE_MAX_ITEMS);
    expect(readLimitForRun({ scope: { limit: 50 } })).toBe(50);
    expect(CHAT_SCOPE_MAX_ITEMS).toBe(1000);
  });

  it('describes only the active fields', () => {
    expect(describeFloor(floorFromFilters({ source: 'a', urgent: '1' }))).toStrictEqual({ source: ['a'], urgent: true });
    expect(describeFloor(NO_FLOOR)).toStrictEqual({});
  });
});
