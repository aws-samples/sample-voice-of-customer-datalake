/**
 * list_scrapers carries each scraper's Radar brand: after a "set up Radar" run the assistant needs it to confirm
 * which brand a scraper feeds (the brand list's sources never show scrapers; see radar-shape.test.ts).
 * Since 5.47 it also lists the app connectors and review pages (GET /scrapers/connectors) with theirs.
 */
import { describe, expect, it } from 'vitest';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';
import { AssistantToolError } from '../errors.js';

const SCRAPERS = {
  scrapers: [
    { id: 'scr_acme', name: 'Acme reviews', enabled: true, radar_brand: 'acme', base_url: 'https://reviews.example/acme' },
    { id: 'scr_ours', name: 'Our reviews', enabled: true, base_url: 'https://reviews.example/ours' },
  ],
};

const CONNECTORS = {
  connectors: [
    { source: 'app_reviews_ios', id: 'ios1', app_name: 'Example Air', app_id: '123456789', radar_brand: 'example-air' },
    { source: 'web_reviews', id: 'web1', app_name: 'Reviews - Globex', url: 'https://reviews.example/globex', source_id: 'web_reviews_globex', radar_brand: 'globex', extra: 'x' },
    { source: 'app_reviews_android', id: 'and1', app_name: 'Our app', package_name: 'com.example.app' },
  ],
};

async function listed(routes: Record<string, unknown>): Promise<{ body: unknown; deps: ReturnType<typeof fakeDeps> }> {
  const deps = fakeDeps(routes);
  const result = await serverTool(deps, 'list_scrapers').execute({}, fakeContext());
  return { body: JSON.parse(result.content), deps };
}

describe('list_scrapers', () => {
  it('returns the Radar brand a scraper feeds, and none for an ordinary scraper', async () => {
    const { body } = await listed({ 'GET /scrapers': SCRAPERS, 'GET /scrapers/connectors': { connectors: [] } });
    expect(body).toMatchObject({
      count: 2,
      scrapers: [{ id: 'scr_acme', radar_brand: 'acme' }, { id: 'scr_ours' }],
    });
    expect(JSON.stringify(body)).not.toContain('"radar_brand":null');
  });

  it('lists the app connectors and review pages with the Radar brand each feeds, through the scrapers API', async () => {
    const { body, deps } = await listed({ 'GET /scrapers': SCRAPERS, 'GET /scrapers/connectors': CONNECTORS });
    expect(body).toMatchObject({
      connector_count: 3,
      connectors: [
        { source: 'app_reviews_ios', id: 'ios1', app_id: '123456789', radar_brand: 'example-air' },
        { source: 'web_reviews', id: 'web1', url: 'https://reviews.example/globex', source_id: 'web_reviews_globex', radar_brand: 'globex' },
        { source: 'app_reviews_android', id: 'and1', package_name: 'com.example.app' },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('"extra"');
    // No new invoke grant: the read goes to the scrapers API, never the integrations API.
    expect(deps.calls.map(({ call }) => call.fn)).toStrictEqual(['scrapers', 'scrapers']);
    expect(deps.calls[1]?.call).toMatchObject({ method: 'GET', resource: '/scrapers/{proxy+}', pathParameters: { proxy: 'connectors' } });
  });

  it('still lists the scrapers when the connectors cannot be read', async () => {
    const failed = new AssistantToolError('unavailable', 'The Scrapers API failed.');
    const { body } = await listed({ 'GET /scrapers': SCRAPERS, 'GET /scrapers/connectors': failed });
    expect(body).toMatchObject({ count: 2, connectors: [] });
    expect(body).toHaveProperty('connectors_note');
  });
});
