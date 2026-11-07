/**
 * The Radar brand bounds (`radar-schemas.ts`, also read by the SPA's approval boundary through `@stream`)
 * against `lambda/shared/radar_brands.py`, `radar_brand_fields.py` and `radar_brand_terms.py`, read as text.
 * A bound the route does not share would mean a save it rejects after the user approved the card.
 */
import { describe, expect, it } from 'vitest';
import {
  BRAND_LABEL_PATTERN, MAX_DOMAIN_INPUT, MAX_LABEL_INPUT, RADAR_BRAND_LANGUAGES, RADAR_BRAND_LIMITS as L, isBrandDomain, isBrandTerm, isFeedUrl,
} from './radar-schemas.js';

/** The Python sources, by file name under `lambda/shared/` (vitest reads them at transform time). */
const PYTHON = import.meta.glob<string>('../../../../../shared/radar_brand{s,_fields,_terms}.py', { eager: true, query: '?raw', import: 'default' });
function python(file: string): string {
  const text = PYTHON[`../../../../../shared/${file}`];
  if (text === undefined) throw new Error(`${file} not loaded`);
  return text;
}
const brands = python('radar_brands.py');
const fields = python('radar_brand_fields.py');
const terms = python('radar_brand_terms.py');

/** `NAME: Final = <int>` at the start of a line. */
function pythonFinal(source: string, name: string): number {
  const captured = new RegExp(`^${name}: Final = (\\d+)$`, 'm').exec(source)?.[1];
  if (captured === undefined) throw new Error(`${name} not found`);
  return Number(captured);
}

/** radar_brand_fields.LANGUAGES as written: `LANGUAGES: Final = ('en', 'pl', …)`. */
function pythonLanguages(): string[] {
  const tuple = /^LANGUAGES: Final = \(([^)]*)\)$/m.exec(fields)?.[1] ?? '';
  return [...tuple.matchAll(/'([a-z]{2})'/g)].map((match) => match[1] ?? '');
}

describe('Radar brand bounds ⇄ the Python modules', () => {
  it('the label and domain caps are radar_brands.py’s', () => {
    expect([pythonFinal(brands, 'MAX_BRAND_CHARS'), pythonFinal(brands, 'MAX_BRAND_DOMAINS')]).toStrictEqual([L.maxLabelChars, L.maxDomains]);
  });

  it('the languages and feed caps are radar_brand_fields.py’s', () => {
    expect([...RADAR_BRAND_LANGUAGES]).toStrictEqual(pythonLanguages());
    expect([pythonFinal(fields, 'MAX_FEED_URLS'), pythonFinal(fields, 'MAX_FEED_URL_CHARS')]).toStrictEqual([L.maxFeedUrls, L.maxFeedUrlChars]);
  });

  it('the term caps are radar_brand_terms.py’s', () => {
    expect([pythonFinal(terms, 'MAX_TERMS'), pythonFinal(terms, 'MAX_TERM_CHARS')]).toStrictEqual([L.maxTerms, L.maxTermChars]);
  });
});

describe('Radar brand rules', () => {
  it('the raw input caps leave room for whitespace and a scheme the normalisation strips', () => {
    expect(MAX_LABEL_INPUT).toBeGreaterThan(L.maxLabelChars);
    expect(MAX_DOMAIN_INPUT).toBeGreaterThan('https://www.'.length + 253);
  });

  it.each([
    ['Acme Air', true], ["O'Brien Co.", true], ['Ünïcode', true], ['x'.repeat(L.maxLabelChars), true],
    ['x'.repeat(L.maxLabelChars + 1), false], ['a/b', false], [' lead', false], ['', false],
  ])('label %j: %s', (label, ok) => {
    expect(BRAND_LABEL_PATTERN.test(label)).toBe(ok);
  });

  it.each([
    ['acme.example', true], ['a.b.c.example', true], ['localhost', false], ['-bad.example', false], ['x.y', false],
  ])('domain %j: %s', (host, ok) => {
    expect(isBrandDomain(host)).toBe(ok);
  });

  it.each([
    ['https://acme.example/feed', true], ['http://acme.example/feed', false], ['https://u:p@acme.example/f', false],
    ['https://acme.example/f#x', false], ['https://10.0.0.1/feed', false], ['https://intranet/feed', false], ['not a url', false],
  ])('feed URL %j: %s', (url, ok) => {
    expect(isFeedUrl(url)).toBe(ok);
  });

  it.each([
    ['in-between', true], ['x'.repeat(L.maxTermChars), true], ['x'.repeat(L.maxTermChars + 1), false], ['say "hi"', false], ['-minus', false], ['', false],
  ])('term %j: %s', (term, ok) => {
    expect(isBrandTerm(term)).toBe(ok);
  });
});
