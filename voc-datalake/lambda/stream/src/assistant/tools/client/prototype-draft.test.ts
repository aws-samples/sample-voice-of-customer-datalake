import { describe, expect, it } from 'vitest';
import { CLIENT_TOOLS, DESTRUCTIVE_CLIENT_TOOLS } from '../../contract.js';
import { CARD_ONLY_WRITE_TOOLS, planWriteTools } from '../../plan/schema.js';
import { buildCatalogue } from '../catalogue.js';
import { buildToolGuidance } from '../guidance.js';
import { toolsetOf } from '../registry.js';
import { clientToolLookup, fakeContext, fakeDeps } from '../test-fixtures.js';
import { MAX_DRAFT_INSTRUCTION_CHARS } from './prototype-draft.js';

const NAME = 'draft_prototype_revision';
const onPrototype = () => fakeContext('project', { projectId: 'proj_1', documentId: 'doc_3' });

describe('draft_prototype_revision', () => {
  const tool = clientToolLookup()(NAME);

  it('is a project write, not destructive, named in the project pack and kept out of plans', () => {
    expect({
      pack: tool.pack,
      inProjectPack: CLIENT_TOOLS.project.includes(NAME),
      destructive: DESTRUCTIVE_CLIENT_TOOLS.includes(NAME),
      cardOnly: (CARD_ONLY_WRITE_TOOLS as readonly string[]).includes(NAME),
      planWrite: planWriteTools('project').includes(NAME),
    }).toStrictEqual({ pack: 'project', inProjectPack: true, destructive: false, cardOnly: true, planWrite: false });
  });

  it('fills the project and the prototype on screen and keeps the instruction trimmed, verbatim otherwise', () => {
    expect(tool.validate({ instruction: '  Make the summary a sticky footer  ' }, onPrototype())).toStrictEqual({
      ok: true, args: { project_id: 'proj_1', document_id: 'doc_3', instruction: 'Make the summary a sticky footer' },
    });
  });

  it.each([
    ['no instruction', {}],
    ['a blank instruction', { instruction: '   ' }],
    ['an instruction past the route’s bound', { instruction: 'x'.repeat(MAX_DRAFT_INSTRUCTION_CHARS + 1) }],
    ['an unknown key', { instruction: 'Blue', pin_ids: ['p1'] }],
  ])('refuses %s', (_label, args) => {
    expect(tool.validate(args, onPrototype()).ok).toBe(false);
  });

  it('accepts an instruction at the bound, and needs a prototype when none is on screen', () => {
    expect(tool.validate({ instruction: 'x'.repeat(MAX_DRAFT_INSTRUCTION_CHARS) }, onPrototype()).ok).toBe(true);
    expect(tool.validate({ instruction: 'Blue' }, fakeContext('project', { projectId: 'proj_1' })).ok).toBe(false);
    expect(MAX_DRAFT_INSTRUCTION_CHARS).toBe(2000);
  });

  it('says on the card it is a preview to apply on the page, with the instruction', () => {
    expect(tool.summarize({ project_id: 'proj_1', document_id: 'doc_3', instruction: 'Blue buttons' })).toBe(
      "Draft a revision of prototype doc_3 in project proj_1 (a preview to apply on its page): 'Blue buttons'");
  });

  it('has no describe step: the card shows the prototype and the instruction, the message is the summary', () => {
    expect(tool.describe).toBeUndefined();
  });

  it('tells the model it drafts only and that there is no apply tool', () => {
    const description = JSON.stringify(tool.spec);
    expect(description).toContain('you cannot apply it');
    expect(buildToolGuidance(toolsetOf(['core', 'project'], buildCatalogue(fakeDeps())))).toContain(
      'then propose draft_prototype_revision with the change as the instruction. It makes a draft preview only');
    expect(Object.values(CLIENT_TOOLS).flat().filter((name) => name.includes('apply'))).toStrictEqual([]);
  });
});
