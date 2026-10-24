/**
 * The mutation run found fallbackChain's allowlist filter unobservable: every
 * model of the shipped order IS allowlisted, so dropping the check changed
 * nothing. With a narrower allowlist the guard shows — a model taken off the
 * allowlist is never a fallback, while the configured model always stays first.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./model-override.js', () => ({
  ALLOWED_MODEL_IDS: new Set(['global.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-sonnet-5']),
}));

const { fallbackChain } = await import('./model-fallback.js');

describe('fallbackChain with a narrower allowlist', () => {
  it('drops fallbacks off the allowlist but keeps the configured model', () => {
    expect(fallbackChain('anthropic.legacy')).toStrictEqual([
      'anthropic.legacy',
      'global.anthropic.claude-sonnet-5-5',
      'global.anthropic.claude-sonnet-5',
    ]);
  });
});
