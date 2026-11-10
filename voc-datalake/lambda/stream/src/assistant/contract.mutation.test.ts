/**
 * Contract pins the mutation run found missing: the earlier specs checked the
 * packs of a few pages (project, scrapers, settings) and the id bounds of
 * `projectId` only, so a page losing its second pack, `feedbackId`/`agentId`
 * accepting a 200-char id or rejecting a 2-char one, a short `tab`/
 * `responseLanguage` being refused, or `dateBasis` accepting nothing all
 * passed unseen.
 */
import { describe, expect, it } from 'vitest';
import { forwardedPropsSchema, MAX_ID_LENGTH, packsForPage, pageContextSchema, type PageKind } from './contract.js';

describe('packsForPage — every page loads core plus its own packs', () => {
  it.each<[PageKind, string]>([
    ['home', 'core+insights'],
    ['dashboard', 'core+insights'],
    ['feedback', 'core+insights'],
    ['categories', 'core+insights'],
    ['problems', 'core+insights'],
    ['chat', 'core+insights'],
    ['projects', 'core+insights'],
    ['project', 'core+project'],
    ['prioritization', 'core+prioritization'],
    ['data-explorer', 'core+insights'],
    ['scrapers', 'core+scrapers'],
    ['feedback-forms', 'core+forms'],
    ['settings', 'core+settings+company'],
    ['memory', 'core+memory'],
    ['agents', 'core+agents+memory'],
    ['agent', 'core+agents+memory'],
    ['company', 'core+company'],
    ['other', 'core+insights'],
  ])('%s → %s for an admin', (kind, packs) => {
    expect(packsForPage(kind, true).join('+')).toBe(packs);
  });

  it('drops only the admin-only settings pack for a non-admin', () => {
    expect(packsForPage('settings', false)).toStrictEqual(['core', 'company']);
  });
});

describe('pageContextSchema — id, tab and title bounds', () => {
  const page = (extra: Record<string, unknown>) => pageContextSchema.safeParse({ kind: 'feedback', path: '/', ...extra }).success;

  it.each(['feedbackId', 'agentId'])('%s accepts 2 and MAX_ID_LENGTH chars, refuses MAX_ID_LENGTH + 1 and empty', (key) => {
    expect(page({ [key]: 'ab' })).toBe(true);
    expect(page({ [key]: 'x'.repeat(MAX_ID_LENGTH) })).toBe(true);
    expect(page({ [key]: 'x'.repeat(MAX_ID_LENGTH + 1) })).toBe(false);
    expect(page({ [key]: '' })).toBe(false);
  });

  it('accepts a short tab and refuses one over 64 chars', () => {
    expect(page({ tab: 'docs' })).toBe(true);
    expect(page({ tab: 'x'.repeat(64) })).toBe(true);
    expect(page({ tab: 'x'.repeat(65) })).toBe(false);
  });
});

describe('forwardedPropsSchema — dateBasis and responseLanguage', () => {
  const props = (extra: Record<string, unknown>) =>
    forwardedPropsSchema.safeParse({ page: { kind: 'home', path: '/' }, ...extra }).success;

  it.each(['imported', 'review'])('accepts dateBasis %s', (dateBasis) => {
    expect(props({ dateBasis })).toBe(true);
  });

  it('refuses an unknown dateBasis', () => {
    expect(props({ dateBasis: 'created' })).toBe(false);
  });

  it('accepts a two-letter language and refuses one over 16 chars', () => {
    expect(props({ responseLanguage: 'en' })).toBe(true);
    expect(props({ responseLanguage: 'x'.repeat(16) })).toBe(true);
    expect(props({ responseLanguage: 'x'.repeat(17) })).toBe(false);
  });
});
