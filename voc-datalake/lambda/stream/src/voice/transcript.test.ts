import { describe, expect, it } from 'vitest';

import { Transcript } from './transcript.js';

const AT = '2026-11-21T12:00:00.000Z';
const transcript = () => new Transcript(new Set(['fb1', 'fb2']), () => AT);

describe('Transcript turns', () => {
  it('numbers the turns as the sides alternate and keeps a side\'s words in its turn', () => {
    const talk = transcript();
    expect(talk.userText('Hi')).toStrictEqual({ turn: 1, text: 'Hi' });
    expect(talk.userText('there')).toStrictEqual({ turn: 1, text: 'Hi there' });
    expect(talk.assistantText('Hello.', 'speculative')).toStrictEqual({ turn: 2, text: 'Hello.', cited: [] });
    expect(talk.lastTurn()).toBe(2);
  });

  it('keeps the persona\'s FINAL text, the SPECULATIVE text when it was interrupted before it', () => {
    const talk = transcript();
    talk.assistantText('I was going to say', 'speculative');
    talk.interrupt();
    talk.userText('Wait');
    talk.assistantText('Draft', 'speculative');
    talk.assistantText('Said', 'final');
    expect(talk.take(true).map((turn) => [turn.text, turn.interrupted])).toStrictEqual([
      ['I was going to say', true], ['Wait', false], ['Said', false],
    ]);
  });

  it('moves a written citation to the turn\'s citations, the pack\'s ids only, and never shows it', () => {
    const talk = transcript();
    const said = talk.assistantText('Late again [fb:fb1] and [fb:elsewhere].', 'final');
    expect(said).toStrictEqual({ turn: 1, text: 'Late again and.', cited: ['fb1'] });
    expect(talk.cite(['fb1', 'fb2', 'fb3'])).toStrictEqual({ turn: 1, cited: ['fb2'] });
    expect(talk.take(true)[0]?.feedback_ids).toStrictEqual(['fb1', 'fb2']);
  });

  it('opens the persona\'s turn when it cites before it speaks', () => {
    const talk = transcript();
    talk.userText('Why?');
    expect(talk.cite(['fb2'])).toStrictEqual({ turn: 2, cited: ['fb2'] });
    expect(talk.assistantText('Because.', 'final')?.turn).toBe(2);
  });
});

describe('Transcript parts', () => {
  it('hands each settled turn over once (every turn but the latest), and the rest at the end', () => {
    const talk = transcript();
    talk.userText('One');
    expect(talk.take(false)).toStrictEqual([]);
    talk.assistantText('Two', 'final');
    expect(talk.take(false)).toStrictEqual([{ role: 'user', text: 'One', at: AT, interrupted: false, feedback_ids: [] }]);
    expect(talk.take(false)).toStrictEqual([]);
    expect(talk.take(true).map((turn) => turn.text)).toStrictEqual(['Two']);
  });

  it('keeps at most 400 turns (the person\'s 401st is captioned nowhere)', () => {
    const talk = transcript();
    for (const index of Array.from({ length: 200 }, (_, at) => at)) {
      talk.userText(`Question ${index}`);
      talk.assistantText('Answer', 'final');
    }
    expect(talk.userText('More')).toBeUndefined();
    expect(talk.lastTurn()).toBe(400);
  });
});

describe('Transcript history', () => {
  it('replays the conversation as USER and ASSISTANT text, starting with the person', () => {
    const talk = transcript();
    talk.assistantText('Hello, I am Maria.', 'final');
    talk.userText('Hi Maria');
    talk.assistantText('How can I help?', 'final');
    expect(talk.history()).toStrictEqual([{ role: 'USER', text: 'Hi Maria' }, { role: 'ASSISTANT', text: 'How can I help?' }]);
  });

  it('drops the oldest turns past 200 KB', () => {
    const talk = new Transcript(new Set(), () => AT);
    const long = 'é'.repeat(2000);
    for (const index of Array.from({ length: 60 }, (_, at) => at)) {
      talk.userText(`${index} ${long}`);
      talk.assistantText(long, 'final');
    }
    const history = talk.history();
    expect(history.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.text), 0)).toBeLessThanOrEqual(200 * 1024);
    expect([history.length, history[0]?.role]).toStrictEqual([50, 'USER']);
  });
});
