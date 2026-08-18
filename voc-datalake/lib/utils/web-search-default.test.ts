/**
 * Regression guard for issue #205: web search deploys BY DEFAULT — the /chat
 * toggle and the research wizard's web-search source are gated on the
 * deployment reporting the feature, so a silent flip back to opt-in would
 * hide both surfaces in every fresh deployment. Unrecognized flag values
 * fail loud: under default-on, a typo must not silently deploy (or skip)
 * the stack.
 */
import { describe, it, expect } from 'vitest';
import { shouldDeployWebSearch } from './web-search-default';

describe('shouldDeployWebSearch', () => {
  it('deploys by default when no context is provided', () => {
    expect(shouldDeployWebSearch(undefined)).toBe(true);
    expect(shouldDeployWebSearch(null)).toBe(true);
  });

  it('stays on for explicit enables (boolean and CLI string, any case)', () => {
    expect(shouldDeployWebSearch(true)).toBe(true);
    expect(shouldDeployWebSearch('true')).toBe(true);
    expect(shouldDeployWebSearch('TRUE')).toBe(true);
  });

  it('opts out on explicit false (boolean and CLI string, any case)', () => {
    expect(shouldDeployWebSearch(false)).toBe(false);
    expect(shouldDeployWebSearch('false')).toBe(false);
    expect(shouldDeployWebSearch('FALSE')).toBe(false);
    expect(shouldDeployWebSearch(' false ')).toBe(false);
  });

  it('throws on unrecognized values instead of guessing', () => {
    for (const bad of ['flase', 'no', '0', 'off', 1, 0, {}]) {
      expect(() => shouldDeployWebSearch(bad), `value: ${JSON.stringify(bad)}`)
        .toThrow(/Unrecognized enableWebSearch/);
    }
  });
});
