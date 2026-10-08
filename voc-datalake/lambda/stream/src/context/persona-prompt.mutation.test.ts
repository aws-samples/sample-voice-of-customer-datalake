/**
 * The roundtable / consult_personas prompt, character for character.
 *
 * The mutation run found that the only earlier coverage (persona-fields.test.ts)
 * built the prompt with every optional section empty and checked substrings, so
 * no test ever saw the referenced documents, feedback, earlier answers, other
 * documents or tagged titles appear, nor the closing and language lines. These
 * assert the whole string, so a dropped section, a reordered one or a changed
 * separator fails.
 */
import { describe, expect, it } from 'vitest';
import { buildSinglePersonaPrompt } from './persona-prompt.js';

const IDENTITY_TAIL = '\nRespond in first person AS this persona. Use "I think...", "As someone who...", etc. '
  + 'Be concise — keep your response to 2-4 paragraphs.\n'
  + 'You are in a roundtable discussion with other customer personas. Speak naturally, share your honest '
  + 'opinion, and don\'t hold back. If you disagree with someone, say so directly.\n\n';
const CLOSING = 'Be specific, accurate, and stay in character.';

describe('buildSinglePersonaPrompt', () => {
  it('is the identity block and the closing line when every optional input is empty', () => {
    const prompt = buildSinglePersonaPrompt('NorthStar', { name: 'Ada' }, '', [], '', [], [], []);

    expect(prompt).toBe(`You are "Ada" — a customer persona in the project "NorthStar".\n${IDENTITY_TAIL}${CLOSING}`);
  });

  it('renders every section, in order, when every input is present', () => {
    const prompt = buildSinglePersonaPrompt(
      'NorthStar',
      { name: 'Ada', tagline: 'Builds things' },
      'DOC BODY',
      ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'],
      '## FEEDBACK\nslow app\n',
      ['doc1', 'doc2'],
      [{ document_id: 'doc1', title: 'PRD' }, { document_id: 'doc2', title: 'FAQ' }, { document_id: 'doc3', title: 'Spec' }],
      [{ name: 'Bo', response: 'Yes.' }, { name: 'Cy', response: 'No.' }],
      'de',
    );

    expect(prompt).toBe(
      'You are "Ada" — a customer persona in the project "NorthStar".\n'
      + 'Your tagline: "Builds things"\n'
      + IDENTITY_TAIL
      + '## REFERENCED DOCUMENTS\nDOC BODY\n'
      + '## FEEDBACK\nslow app\n'
      + '## What other personas have said (you may agree, disagree, or build on their points)\n\n'
      + '**Bo:** Yes.\n\n**Cy:** No.\n\n'
      + '## Other Available Documents\no1\no2\no3\no4\no5\n\n'
      + '📄 The user has tagged: PRD, FAQ. Use the document content above.\n\n'
      + CLOSING
      + '\n\nIMPORTANT: You MUST respond entirely in German (de). All text, headings, labels, and explanations must be in German.',
    );
  });

  it('matches a document without an id only by an empty selected id', () => {
    const untitled = [{ title: 'Draft' }];
    const tagged = (ids: string[]): string => buildSinglePersonaPrompt('P', { name: 'Ada' }, '', [], '', ids, untitled, []);

    expect(tagged([''])).toContain('📄 The user has tagged: Draft. Use');
    expect(tagged(['doc1'])).toContain('📄 The user has tagged: . Use');
  });
});
