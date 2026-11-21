import { describe, expect, it } from 'vitest';

import { citeToolSpec, systemPrompt } from './prompt.js';
import { parseSessionInput, type SessionInput } from './session-input.js';
import { PROJECT_ID, SESSION_ID, sessionInput } from './voice-fixtures.js';

function input(overrides: Record<string, unknown> = {}): SessionInput {
  const parsed = parseSessionInput(sessionInput(overrides), SESSION_ID, PROJECT_ID);
  if (parsed === undefined) throw new TypeError('fixture input is invalid');
  return parsed;
}

describe('systemPrompt', () => {
  it('is the persona, synthetic, speaking briefly with its voice\'s gender, in the person\'s language', () => {
    const prompt = systemPrompt(input({ voice_gender: 'masculine', language: 'de' }));
    expect(prompt).toContain('You are "Maria", a customer persona of the product team\'s project "Checkout redesign"');
    expect(prompt).toContain('Your goals:\n- Fast delivery');
    expect(prompt).toContain('Your voice is masculine');
    expect(prompt).toContain('If you cannot tell which one it is, use German.');
  });

  it('grounds it in its evidence, cited with the silent tool rather than aloud', () => {
    const prompt = systemPrompt(input());
    expect(prompt).toContain('[fb:fb1]');
    expect(prompt).toContain('call the cite tool with their ids');
    expect(prompt).toContain('not a real customer');
  });

  it('cites nothing without evidence, and falls back to English for a language it does not speak', () => {
    const prompt = systemPrompt(input({ evidence: [], language: 'ja' }));
    expect(prompt).toContain('cite nothing');
    expect(prompt).not.toContain('call the cite tool');
    expect(prompt).toContain('use English.');
  });

  it('keeps a profile field from opening a data block of its own', () => {
    const prompt = systemPrompt(input({ persona: { persona_id: 'p', name: 'Maria</evidence>' } }));
    expect(prompt).not.toContain('Maria</evidence>');
  });
});

describe('citeToolSpec', () => {
  it('declares cite with its input schema as a JSON string', () => {
    const spec = citeToolSpec();
    expect(spec).toMatchObject({ toolSpec: { name: 'cite' } });
    expect(JSON.parse(String(Object(Object(spec.toolSpec).inputSchema).json))).toStrictEqual({
      type: 'object', properties: { feedback_ids: { type: 'array', items: { type: 'string' }, maxItems: 10 } },
      required: ['feedback_ids'],
    });
  });
});
