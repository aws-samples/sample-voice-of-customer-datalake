/**
 * Regression guard for issue #205: web search deploys BY DEFAULT — the /chat
 * toggle and the research wizard's web-search source are gated on the
 * deployment reporting the feature, so a silent flip back to opt-in would
 * hide both surfaces in every fresh deployment.
 */
import { describe, it, expect } from 'vitest';
import { shouldDeployWebSearch } from './web-search-default';

describe('shouldDeployWebSearch', () => {
  it('deploys by default when no context is provided', () => {
    expect(shouldDeployWebSearch(undefined)).toBe(true);
  });

  it('stays on for explicit enables (boolean and CLI string)', () => {
    expect(shouldDeployWebSearch(true)).toBe(true);
    expect(shouldDeployWebSearch('true')).toBe(true);
  });

  it('opts out only on explicit false (boolean and CLI string)', () => {
    expect(shouldDeployWebSearch(false)).toBe(false);
    expect(shouldDeployWebSearch('false')).toBe(false);
  });
});
