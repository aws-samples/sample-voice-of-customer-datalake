import { describe, expect, it } from 'vitest';
import { CLIENT_TOOLS } from '../../contract.js';
import { CARD_ONLY_WRITE_TOOLS, planWriteTools } from '../../plan/schema.js';
import { clientToolLookup, fakeContext } from '../test-fixtures.js';
import { WALKTHROUGH_LIMITS } from './prototype-walkthrough.js';

const NAME = 'set_prototype_walkthrough';
const onPrototype = () => fakeContext('project', { projectId: 'proj_1', documentId: 'doc_3' });
const STEP = { title: 'Start here', body: 'Pick a plan to begin', selector: '#plan' };
const ANCHORED = { title: 'Pay', body: 'The total', anchor: { route: '/checkout', bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } } };

describe('set_prototype_walkthrough', () => {
  const tool = clientToolLookup()(NAME);

  it('is a project write, card-only, defaulting to the prototype on screen', () => {
    expect({
      inPack: CLIENT_TOOLS.project.includes(NAME),
      cardOnly: (CARD_ONLY_WRITE_TOOLS as readonly string[]).includes(NAME),
      planWrite: planWriteTools('project').includes(NAME),
    }).toStrictEqual({ inPack: true, cardOnly: true, planWrite: false });
    expect(tool.validate({ steps: [STEP, ANCHORED] }, onPrototype())).toStrictEqual({
      ok: true, args: { project_id: 'proj_1', document_id: 'doc_3', steps: [STEP, ANCHORED] },
    });
  });

  it.each([
    ['a step without a selector or an anchor', [{ title: 'A', body: 'B' }]],
    ['a title past 80 characters', [{ ...STEP, title: 'x'.repeat(WALKTHROUGH_LIMITS.titleChars + 1) }]],
    ['a body past 280 characters', [{ ...STEP, body: 'x'.repeat(WALKTHROUGH_LIMITS.bodyChars + 1) }]],
    ['a bbox outside the viewport', [{ ...ANCHORED, anchor: { bbox: { x: 2, y: 0, w: 0, h: 0 } } }]],
    ['more than 10 steps', Array.from({ length: WALKTHROUGH_LIMITS.steps + 1 }, () => STEP)],
    ['an unknown key in a step', [{ ...STEP, html: '<b>x</b>' }]],
  ])('refuses %s', (_label, steps) => {
    expect(tool.validate({ steps }, onPrototype()).ok).toBe(false);
  });

  it('says how many steps it saves, or that it removes them', () => {
    expect(tool.summarize({ project_id: 'p', document_id: 'd', steps: [STEP, ANCHORED] })).toBe(
      'Save a 2-step walkthrough on prototype d in project p.');
    expect(tool.summarize({ project_id: 'p', document_id: 'd', steps: [] })).toBe(
      'Remove the walkthrough of prototype d in project p.');
  });
});
