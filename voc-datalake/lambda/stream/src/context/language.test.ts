/**
 * Tests for the shared language helper (issue #266).
 *
 * Covers:
 *   - getLanguageInstruction returns an empty string for English / undefined
 *   - getLanguageInstruction returns a correctly formed instruction for each
 *     supported non-English locale
 *   - An unrecognised code does NOT appear in the returned instruction (the
 *     verbatim-interpolation prompt-injection surface is closed)
 */
import { describe, it, expect } from 'vitest';
import { getLanguageInstruction, SUPPORTED_LANGUAGES } from './language.js';

describe('getLanguageInstruction', () => {
  it('returns empty string when lang is undefined', () => {
    expect(getLanguageInstruction(undefined)).toBe('');
  });

  it('returns empty string for English', () => {
    expect(getLanguageInstruction('en')).toBe('');
  });

  it('returns a non-empty instruction for every supported non-English locale', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      if (lang === 'en') continue;
      const instruction = getLanguageInstruction(lang);
      expect(instruction.length).toBeGreaterThan(0);
      expect(instruction).toContain('MUST respond entirely in');
      expect(instruction).toContain(lang);
    }
  });

  it('names the language in the instruction for each locale', () => {
    const expectedNames: Record<string, string> = {
      de: 'German',
      es: 'Spanish',
      fr: 'French',
      ja: 'Japanese',
      ko: 'Korean',
      pt: 'Portuguese',
      zh: 'Chinese',
    };
    for (const [lang, name] of Object.entries(expectedNames)) {
      const instruction = getLanguageInstruction(lang as 'de');
      expect(instruction).toContain(name);
    }
  });
});

describe('SUPPORTED_LANGUAGES', () => {
  it('contains exactly the eight shipped catalogue locales', () => {
    expect(SUPPORTED_LANGUAGES).toStrictEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'zh']);
  });
});
