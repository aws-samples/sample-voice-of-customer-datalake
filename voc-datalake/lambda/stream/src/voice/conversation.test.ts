import { describe, expect, it } from 'vitest';

import { Conversation } from './conversation.js';
import type { RelayMessage } from './protocol.js';
import { Transcript } from './transcript.js';

function conversation() {
  const sent: RelayMessage[] = [];
  const results: Array<[string, Record<string, unknown>]> = [];
  const ends: string[] = [];
  const talk = new Conversation(new Transcript(new Set(['fb1']), () => '2026-11-21T12:00:00.000Z'), {
    send: (message) => { sent.push(message); },
    audio: () => { ends.push('audio'); },
    toolResult: (id, result) => { results.push([id, result]); },
    assistantTurnEnded: () => { ends.push('assistant'); },
  });
  return { talk, sent, results, ends };
}

describe('Conversation', () => {
  it('takes Nova Sonic v1\'s interrupted text as barge-in, never as a caption', () => {
    const run = conversation();
    run.talk.handle({ kind: 'text', contentId: 'c', role: 'ASSISTANT', content: '{ "interrupted" : true }' });
    expect(run.sent).toStrictEqual([{ type: 'interrupted' }]);
  });

  it('reads a text\'s speaker from its block when the text names none, and ignores a speaker it does not know', () => {
    const run = conversation();
    run.talk.handle({ kind: 'contentStart', contentId: 'u', role: 'USER', type: 'TEXT', stage: 'final' });
    run.talk.handle({ kind: 'text', contentId: 'u', role: '', content: 'Hello' });
    run.talk.handle({ kind: 'text', contentId: 's', role: 'SYSTEM', content: 'Nothing' });
    expect(run.sent).toStrictEqual([{ type: 'caption', role: 'user', stage: 'final', text: 'Hello', turn: 1 }]);
  });

  it('ends the person\'s turn at their block\'s END_TURN, and nothing at a partial turn or an unknown block', () => {
    const run = conversation();
    run.talk.handle({ kind: 'contentStart', contentId: 'u', role: 'USER', type: 'TEXT', stage: 'final' });
    run.talk.handle({ kind: 'text', contentId: 'u', role: 'USER', content: 'Hi' });
    run.talk.handle({ kind: 'contentEnd', contentId: 'u', stopReason: 'END_TURN', type: 'TEXT' });
    run.talk.handle({ kind: 'contentEnd', contentId: 'gone', stopReason: 'END_TURN', type: 'AUDIO' });
    run.talk.handle({ kind: 'contentStart', contentId: 'p', role: 'ASSISTANT', type: 'TEXT', stage: 'speculative' });
    run.talk.handle({ kind: 'contentEnd', contentId: 'p', stopReason: 'PARTIAL_TURN', type: 'TEXT' });
    expect(run.sent.at(-1)).toStrictEqual({ type: 'turn_end', role: 'user', turn: 1 });
    expect(run.ends).toStrictEqual([]);
  });

  it('answers a tool it does not have with ok false, and a cite naming nothing it holds without a citation', () => {
    const run = conversation();
    run.talk.handle({ kind: 'toolUse', toolName: 'search', toolUseId: 't1', content: '{}' });
    run.talk.handle({ kind: 'toolUse', toolName: 'cite', toolUseId: 't2', content: 'not json' });
    run.talk.handle({ kind: 'usage', totals: { speech_in: 1, speech_out: 0, text_in: 0, text_out: 0 } });
    expect(run.results).toStrictEqual([['t1', { ok: false, error: 'unknown tool' }], ['t2', { ok: true }]]);
    expect(run.sent).toStrictEqual([]);
  });

  it('shows the ids a persona wrote into its text as a citation', () => {
    const run = conversation();
    run.talk.handle({ kind: 'text', contentId: 'a', role: 'ASSISTANT', content: 'Nine days [fb:fb1].' });
    expect(run.sent).toStrictEqual([
      { type: 'caption', role: 'assistant', stage: 'final', text: 'Nine days.', turn: 1 },
      { type: 'citation', turn: 1, feedback_ids: ['fb1'] },
    ]);
  });
});
