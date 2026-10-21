/**
 * Tests for the stream Lambda's copy of the shared feedback filter model.
 */
import { describe, it, expect } from 'vitest';
import {
  parseChatFilters,
  matchesChatFilters,
  isEmptyChatFilters,
  describeChatFilters,
  EMPTY_CHAT_FILTERS,
  type ChatFilters,
} from './feedback-filters.js';

const ITEM = {
  source_platform: 'webscraper',
  category: 'delivery',
  subcategory: 'late',
  sentiment_label: 'negative',
  usefulness: 'high',
  urgency: 'high',
};

describe('parseChatFilters', () => {
  it('splits comma strings into trimmed, de-duplicated lists', () => {
    const f = parseChatFilters({ source: 'webscraper, manual_import , webscraper', sentiment: 'negative' });
    expect(f.sources).toStrictEqual(['webscraper', 'manual_import']);
    expect(f.sentiments).toStrictEqual(['negative']);
  });

  it('accepts arrays as well as comma strings', () => {
    expect(parseChatFilters({ category: ['delivery', 'pricing'] }).categories).toStrictEqual(['delivery', 'pricing']);
  });

  it('reads urgent from a boolean or a truthy string', () => {
    expect(parseChatFilters({ urgent: true }).urgentOnly).toBe(true);
    expect(parseChatFilters({ urgent: 'true' }).urgentOnly).toBe(true);
    expect(parseChatFilters({ urgent: '1' }).urgentOnly).toBe(true);
    expect(parseChatFilters({ urgent: 'false' }).urgentOnly).toBe(false);
    expect(parseChatFilters({}).urgentOnly).toBe(false);
  });

  it('carries the usefulness enrichment dimension', () => {
    expect(parseChatFilters({ usefulness: 'high,unscored' }).usefulness).toStrictEqual(['high', 'unscored']);
  });

  it('degrades a malformed payload to the empty filter', () => {
    for (const raw of [null, undefined, 42, 'nope']) {
      expect(parseChatFilters(raw)).toStrictEqual(EMPTY_CHAT_FILTERS);
    }
  });

  it('ignores cf_* keys rather than rejecting them (tool cannot scope on them)', () => {
    const f = parseChatFilters({ source: 'webscraper', cf_tier: 'Gold' });
    expect(f.sources).toStrictEqual(['webscraper']);
  });
});

describe('isEmptyChatFilters', () => {
  it('is true only when nothing narrows the set', () => {
    expect(isEmptyChatFilters(EMPTY_CHAT_FILTERS)).toBe(true);
    expect(isEmptyChatFilters(parseChatFilters({ source: 'webscraper' }))).toBe(false);
    expect(isEmptyChatFilters(parseChatFilters({ urgent: true }))).toBe(false);
  });
});

describe('matchesChatFilters', () => {
  it('passes everything for the empty filter', () => {
    expect(matchesChatFilters(ITEM, EMPTY_CHAT_FILTERS)).toBe(true);
    expect(matchesChatFilters({}, EMPTY_CHAT_FILTERS)).toBe(true);
  });

  it('ANDs across dimensions, ORs within one', () => {
    expect(matchesChatFilters(ITEM, parseChatFilters({ source: 'webscraper,other' }))).toBe(true);
    expect(matchesChatFilters(ITEM, parseChatFilters({ source: 'other' }))).toBe(false);
    expect(matchesChatFilters(ITEM, parseChatFilters({ source: 'webscraper', category: 'pricing' }))).toBe(false);
  });

  it('matches urgent-only against the high urgency value', () => {
    expect(matchesChatFilters(ITEM, parseChatFilters({ urgent: true }))).toBe(true);
    expect(matchesChatFilters({ ...ITEM, urgency: 'low' }, parseChatFilters({ urgent: true }))).toBe(false);
  });

  it('treats a missing usefulness value as unscored', () => {
    const unscored = parseChatFilters({ usefulness: 'unscored' });
    expect(matchesChatFilters({ source_platform: 'x' }, unscored)).toBe(true);
    expect(matchesChatFilters({ usefulness: '' }, unscored)).toBe(true);
    expect(matchesChatFilters(ITEM, unscored)).toBe(false);
  });

  it('narrows by subcategory', () => {
    expect(matchesChatFilters(ITEM, parseChatFilters({ subcategory: 'late' }))).toBe(true);
    expect(matchesChatFilters(ITEM, parseChatFilters({ subcategory: 'early' }))).toBe(false);
  });
});

describe('describeChatFilters', () => {
  it('summarizes the active dimensions and omits the empty ones', () => {
    const f: ChatFilters = parseChatFilters({ source: 'webscraper', usefulness: 'high', urgent: true });
    const desc = describeChatFilters(f);
    expect(desc).toContain('Sources: webscraper');
    expect(desc).toContain('Usefulness: high');
    expect(desc).toContain('Urgent only');
    expect(desc).not.toContain('Categories');
  });

  it('is empty for the empty filter', () => {
    expect(describeChatFilters(EMPTY_CHAT_FILTERS)).toBe('');
  });
});
