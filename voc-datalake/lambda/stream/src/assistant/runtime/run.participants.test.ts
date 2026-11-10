/**
 * add_participants end to end through the runtime: the approval card's one-line
 * message names the stored list (the approver knows lists by name, not by id).
 */
import { describe, expect, it } from 'vitest';
import { runBody } from './__fixtures__/fakes.js';
import { finished, harness, run, silenceConsole } from './__fixtures__/harness.js';
import { buildCatalogue } from '../tools/catalogue.js';
import { selectToolset } from '../tools/registry.js';
import { fakeDeps } from '../tools/test-fixtures.js';

silenceConsole();

const PAGE = { kind: 'participants', path: '/participants' } as const;
const MEMBER = { sub: 'user-sub', 'cognito:groups': 'users', 'cognito:username': 'user-1' };
const LIST_ID = 'lst_0123456789abcdef';
const LISTS = { lists: [{ list_id: LIST_ID, name: 'Beta customers', kind: 'beta', member_count: 4 }] };
const INPUT = { list_id: LIST_ID, people: [{ email: 'ana@example.com' }, { email: 'dev@example.com' }] };

function participantsHarness() {
  const catalogue = buildCatalogue(fakeDeps({ 'GET /participants/lists': LISTS }));
  const toolset = selectToolset(catalogue, { page: PAGE, isAdmin: false, webSearch: false, alsoInclude: ['add_participants'] });
  return harness([{ text: 'On it.', toolUses: [{ id: 'tu_p', name: 'add_participants', input: INPUT }] }, { text: 'Noted.' }], toolset);
}

describe('add_participants through the runtime', () => {
  it('raises a card whose message names the list, not its id', async () => {
    const events = await run(runBody({ forwardedProps: { page: PAGE } }), participantsHarness(), MEMBER);
    expect(finished(events).outcome).toMatchObject({
      type: 'interrupt',
      interrupts: [{ id: 'approval:tu_p', message: "Add 2 person rows to the participant list 'Beta customers'.", metadata: { toolName: 'add_participants' } }],
    });
  });
});
