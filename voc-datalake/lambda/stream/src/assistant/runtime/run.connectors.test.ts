/**
 * Connector writes end to end through the runtime: a valid create_scraper ends
 * the run with a tool_approval interrupt carrying exactly the validated args;
 * a colliding id or a non-admin caller is answered with an error toolResult and
 * no card.
 */
import { describe, expect, it } from 'vitest';
import { runBody } from './__fixtures__/fakes.js';
import { errorToolResult, finished, harness, lastToolCallArgs, lastUserContent, run, silenceConsole } from './__fixtures__/harness.js';
import { buildCatalogue } from '../tools/catalogue.js';
import { selectToolset } from '../tools/registry.js';
import { fakeDeps } from '../tools/test-fixtures.js';
import { nth } from '../../lib/nth-fixtures.js';

silenceConsole();

const PAGE = { kind: 'scrapers', path: '/scrapers' } as const;
const ADMIN = { sub: 'admin-sub', 'cognito:groups': 'admins' };
const PROPOSAL = { id: 'acme', name: '  Acme reviews ', extraction_method: 'jsonld', base_url: 'https://www.acme.example/reviews' };

function connectorHarness(stored: unknown[], isAdmin = true) {
  const catalogue = buildCatalogue(fakeDeps({ 'GET /scrapers': { scrapers: stored } }));
  const toolset = selectToolset(catalogue, { page: PAGE, isAdmin, webSearch: false, alsoInclude: ['create_scraper'] });
  return harness([{ text: 'Here is the scraper.', toolUses: [{ id: 'tu_s', name: 'create_scraper', input: PROPOSAL }] }, { text: 'Noted.' }], toolset);
}

const body = runBody({ forwardedProps: { page: PAGE } });

describe('create_scraper through the runtime', () => {
  it('ends the run with an approval interrupt for exactly the validated args', async () => {
    const events = await run(body, connectorHarness([{ id: 'other' }]), ADMIN);
    expect(finished(events).outcome).toMatchObject({
      type: 'interrupt',
      interrupts: [{ id: 'approval:tu_s', reason: 'tool_approval', message: "Create web scraper 'Acme reviews' (acme).", metadata: { toolName: 'create_scraper', risk: 'write' } }],
    });
    expect(lastToolCallArgs(events)).toStrictEqual({ ...PROPOSAL, name: 'Acme reviews' });
  });

  it('answers an existing id with an error result and no card', async () => {
    const h = connectorHarness([{ id: 'acme' }]);
    const events = await run(body, h, ADMIN);
    expect(lastUserContent(nth(h.calls, 1))).toStrictEqual(errorToolResult(
      'tu_s', 'Error: a scraper with id "acme" already exists. Pick another id, or propose update_scraper to change it.',
    ));
    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
  });

  it('refuses a non-admin before any card (the tool is not even offered)', async () => {
    const h = connectorHarness([], false);
    const events = await run(body, h);
    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
    expect(lastUserContent(nth(h.calls, 1))).toStrictEqual(errorToolResult('tu_s', 'Error: unknown tool "create_scraper".'));
  });
});
