/**
 * A persona focus group through a whole run (`forwardedProps.focusGroup`): it replaces the model's own turn (no agent
 * loop call), is refused off a project page, with mentions, past its limits or where the stream does not run one, and
 * ends with the run's feedback sources (the cited reviews) and RUN_FINISHED, Stopped when the person stopped it.
 */
import { describe, it, expect } from 'vitest';
import { EventType } from '@ag-ui/core';
import { CUSTOM_EVENTS } from '../contract.js';
import { runBody } from './__fixtures__/fakes.js';
import { finished, harness, run, silenceConsole } from './__fixtures__/harness.js';
import type { FocusGroupInput } from './focus-group.js';
import { emptyUsage } from './usage.js';

const PROJECT_PAGE = { kind: 'project', path: '/projects/proj_1', projectId: 'proj_1' };
const GROUP = { persona_ids: ['pa', 'pb'], rounds: 2 };

function body(page: Record<string, unknown>, extra: Record<string, unknown>, text = 'Shorter slots?'): Record<string, unknown> {
  return runBody({ forwardedProps: { page, ...extra }, messages: [{ id: 'u1', role: 'user', content: text }] });
}

silenceConsole();

describe('runAssistant — focus groups', () => {
  it('runs the focus group instead of the model and ends with its sources', async () => {
    const h = harness([{ text: 'never' }]);
    const seen: FocusGroupInput[] = [];
    h.deps.focusGroup = (input) => {
      seen.push(input);
      return Promise.resolve({ sources: [{ feedback_id: 'f1', text: 'Late' }], librarySources: [], usage: emptyUsage(),
        stopped: false });
    };
    const events = await run(body(PROJECT_PAGE, { focusGroup: GROUP }), h);
    expect(h.calls).toHaveLength(0);
    expect(seen.map((input) => ({ group: input.focusGroup, topic: input.topic, project: input.ctx.page.projectId })))
      .toStrictEqual([{ group: GROUP, topic: 'Shorter slots?', project: 'proj_1' }]);
    const sources = events.find((event) => event.type === EventType.CUSTOM && 'name' in event
      && event.name === CUSTOM_EVENTS.sources);
    expect(sources).toMatchObject({ value: { feedback: [{ feedback_id: 'f1' }], web: [], library: [] } });
    expect(finished(events)).toMatchObject({ outcome: { type: 'success' } });
  });

  it('marks a stopped focus group as stopped', async () => {
    const h = harness([]);
    h.deps.focusGroup = () => Promise.resolve({ sources: [], librarySources: [], usage: emptyUsage(), stopped: true });
    const events = await run(body(PROJECT_PAGE, { focusGroup: GROUP }), h);
    expect(events.some((event) => event.type === EventType.CUSTOM && 'name' in event
      && event.name === CUSTOM_EVENTS.stopped)).toBe(true);
  });

  it.each([
    ['off a project page', { kind: 'dashboard', path: '/' }, { focusGroup: GROUP }, 'only available on a project page'],
    ['with mentions', PROJECT_PAGE, { focusGroup: GROUP, mentions: { personas: 'all' } }, 'without mentions'],
    ['one persona', PROJECT_PAGE, { focusGroup: { persona_ids: ['pa'], rounds: 1 } }, 'Invalid forwardedProps'],
    ['seven personas', PROJECT_PAGE, { focusGroup: { persona_ids: ['1', '2', '3', '4', '5', '6', '7'], rounds: 1 } },
      'Invalid forwardedProps'],
    ['four rounds', PROJECT_PAGE, { focusGroup: { ...GROUP, rounds: 4 } }, 'Invalid forwardedProps'],
    ['a persona twice', PROJECT_PAGE, { focusGroup: { ...GROUP, persona_ids: ['pa', 'pa'] } }, 'Invalid forwardedProps'],
    ['an unknown key', PROJECT_PAGE, { focusGroup: { ...GROUP, model: 'x' } }, 'Invalid forwardedProps'],
  ])('refuses a focus group %s before any model call', async (_label, page, extra, message) => {
    const h = harness([{ text: 'never' }]);
    h.deps.focusGroup = () => Promise.reject(new Error('must not run'));
    const events = await run(body(page, extra), h);
    expect(h.calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: expect.stringContaining(message) });
  });

  it('refuses a focus group where the stream runs none', async () => {
    const h = harness([{ text: 'never' }]);
    const events = await run(body(PROJECT_PAGE, { focusGroup: GROUP }), h);
    expect(h.calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: expect.stringContaining('not available') });
  });
});
