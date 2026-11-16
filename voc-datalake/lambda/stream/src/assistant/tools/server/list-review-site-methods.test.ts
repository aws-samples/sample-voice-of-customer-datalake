/**
 * list_review_site_methods: what THIS workspace learned of each review site (GET /scrapers/review-methods, the
 * scrapers API, as list_scrapers reads the connectors: no new invoke grant), shaped for the model; an empty answer
 * says nothing is known yet and never invents a site's method (docs/web-reviews.md → Learning which method works).
 */
import { describe, expect, it } from 'vitest';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';
import { NOTHING_LEARNED_NOTE } from './workspace.js';

const RECORDS = {
  methods: [{
    domain: 'capterra.com', best_method: 'bedrock_web_search', learned_at: '2026-11-15T10:00:00+00:00',
    browser_recheck_due_at: '2026-11-29T10:00:00+00:00', pk: 'WS#ws_x#WEB_REVIEWS#METHODS', extra: 'x',
    methods: {
      browser: { last_outcome: 'blocked:Cloudflare', last_at: '2026-11-15T10:00:00+00:00', successes: 0, failures: 1, last_reviews: 0, secret: 'y' },
      bedrock_web_search: { last_outcome: 'readable', last_at: '2026-11-15T10:00:01+00:00', successes: 1, failures: 0, last_reviews: 11 },
      broken: 'not a record',
    },
  }],
};

async function listed(body: unknown) {
  const deps = fakeDeps({ 'GET /scrapers/review-methods': body });
  const result = await serverTool(deps, 'list_review_site_methods').execute({}, fakeContext('scrapers'));
  return { body: JSON.parse(result.content) as unknown, deps };
}

describe('list_review_site_methods', () => {
  it('reads the workspace’s own records through the scrapers API, as the caller', async () => {
    const { deps } = await listed(RECORDS);
    expect(deps.calls.map(({ call }) => call)).toStrictEqual([{
      fn: 'scrapers', method: 'GET', path: '/scrapers/review-methods', resource: '/scrapers/{proxy+}',
      pathParameters: { proxy: 'review-methods' },
    }]);
  });

  it('answers each site’s best method, when it was learned, the re-check and each method’s last outcome', async () => {
    const { body } = await listed(RECORDS);
    expect(body).toStrictEqual({
      count: 1,
      sites: [{
        domain: 'capterra.com', best_method: 'bedrock_web_search', learned_at: '2026-11-15T10:00:00+00:00',
        browser_recheck_due_at: '2026-11-29T10:00:00+00:00',
        methods: {
          browser: { last_outcome: 'blocked:Cloudflare', last_at: '2026-11-15T10:00:00+00:00', successes: 0, failures: 1, last_reviews: 0 },
          bedrock_web_search: { last_outcome: 'readable', last_at: '2026-11-15T10:00:01+00:00', successes: 1, failures: 0, last_reviews: 11 },
        },
      }],
    });
  });

  it('says nothing is learned yet when the workspace has no record, and names no site', async () => {
    const { body } = await listed({ methods: [] });
    expect(body).toStrictEqual({ count: 0, sites: [], note: NOTHING_LEARNED_NOTE });
    expect(NOTHING_LEARNED_NOTE).toContain('first run');
    expect(NOTHING_LEARNED_NOTE).not.toMatch(/\.com|Cloudflare|DataDome/);
  });

  it('takes no arguments', async () => {
    const deps = fakeDeps({ 'GET /scrapers/review-methods': RECORDS });
    await expect(serverTool(deps, 'list_review_site_methods').execute({ domain: 'g2.com' }, fakeContext('scrapers')))
      .rejects.toThrow(/domain/);
    expect(deps.calls).toStrictEqual([]);
  });
});
