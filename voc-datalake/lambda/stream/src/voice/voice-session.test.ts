import { describe, expect, it } from 'vitest';

import { Meter, pricesFor } from './meter.js';
import { GOODBYE_TURN } from './prompt.js';
import { VoiceSession } from './voice-session.js';
import {
  FakeChannel, FakeStore, FakeTransport, ManualClock, PROJECT_ID, SESSION_ID, sessionInput, settle,
} from './voice-fixtures.js';

const MINUTE = 60_000;
/** One microphone frame: 64 ms of PCM16 at 16 kHz. */
const FRAME = Buffer.alloc(2048, 1);

function harness(input: Record<string, unknown> = sessionInput(), ids = { sessionId: SESSION_ID, scope: PROJECT_ID }) {
  const clock = new ManualClock();
  const store = new FakeStore();
  store.input = input;
  const transport = new FakeTransport();
  const channel = new FakeChannel();
  const prices = pricesFor('amazon.nova-2-5-sonic', 'us-west-2');
  const session = new VoiceSession({ store, transport, clock, meter: () => new Meter(prices) }, ids, channel);
  return { clock, store, transport, channel, session };
}

async function started(input?: Record<string, unknown>) {
  const run = harness(input);
  void run.session.start();
  await settle();
  return run;
}

function named(name: string): Error {
  return Object.assign(new Error(name), { name });
}

type Run = Awaited<ReturnType<typeof started>>;

/** The persona says `text` and finishes its spoken turn (a response: an ASSISTANT TEXT block, then its AUDIO block's
 *  END_TURN). */
async function personaSays(run: Run, text: string, stream = 0): Promise<void> {
  const model = run.transport.stream(stream);
  model.emit('completionStart', { completionId: `c-${text}` });
  model.emit('contentStart', { contentId: `t-${text}`, role: 'ASSISTANT', type: 'TEXT', additionalModelFields: '{"generationStage":"FINAL"}' });
  model.emit('textOutput', { contentId: `t-${text}`, role: 'ASSISTANT', content: text });
  model.emit('contentStart', { contentId: `a-${text}`, role: 'ASSISTANT', type: 'AUDIO' });
  model.emit('contentEnd', { contentId: `a-${text}`, stopReason: 'END_TURN', type: 'AUDIO' });
  await settle();
}

async function personSays(run: Run, text: string, stream = 0): Promise<void> {
  const model = run.transport.stream(stream);
  model.emit('contentStart', { contentId: `u-${text}`, role: 'USER', type: 'TEXT' });
  model.emit('textOutput', { contentId: `u-${text}`, role: 'USER', content: text });
  await settle();
}

describe('VoiceSession start', () => {
  it('activates once, opens one stream and says ready with the voice, the limit and the minutes left', async () => {
    const run = await started();
    expect(run.channel.of('ready')).toStrictEqual([{ type: 'ready', voice_id: 'tiffany', session_seconds: 900, minutes_left: 250 }]);
    expect(run.store.calls.slice(0, 2)).toStrictEqual([`activate:${SESSION_ID}`, `loadInput:${SESSION_ID}`]);
    expect(run.transport.streams).toHaveLength(1);
  });

  it('opens the stream with the session, the prompt, the system text and then the microphone', async () => {
    const run = await started();
    expect(run.transport.stream(0).names()).toStrictEqual(
      ['sessionStart', 'promptStart', 'contentStart', 'textInput', 'contentEnd', 'contentStart']);
    expect(run.transport.stream(0).bodies('textInput')[0]?.content).toContain('You are "Maria"');
  });

  it('refuses a session the store does not activate (used, ended, past its minute or gone) and writes nothing', async () => {
    const run = harness();
    run.store.activation = false;
    await run.session.start();
    expect(run.channel.messages).toStrictEqual([{ type: 'ended', reason: 'refused' }]);
    expect(run.channel.closedWith).toBe(1008);
    expect(run.store.ended).toBeUndefined();
    expect(run.transport.streams).toHaveLength(0);
  });

  it('refuses an input that names another session, and marks the activated row ended', async () => {
    const run = harness(sessionInput({ session_id: 'ffffffff-d9cb-469f-a165-70867728950e' }));
    await run.session.start();
    expect(run.channel.of('ended')).toStrictEqual([{ type: 'ended', reason: 'refused' }]);
    expect(run.store.ended).toBe('refused');
    expect(run.store.calls).toContain(`leaveLive:${SESSION_ID}`);
  });

  it('refuses a malformed session id or scope before it reads anything', async () => {
    const run = harness(sessionInput(), { sessionId: 'short', scope: PROJECT_ID });
    await run.session.start();
    expect(run.store.calls).toStrictEqual([]);
    expect(run.channel.closedWith).toBe(1008);
  });

  it('says busy and closes 1011 when the model will not open a stream', async () => {
    const run = harness();
    run.transport.openError = named('ThrottlingException');
    await run.session.start();
    expect(run.channel.of('ended')).toStrictEqual([{ type: 'ended', reason: 'busy' }]);
    expect(run.channel.closedWith).toBe(1011);
    expect(run.store.ended).toBe('busy');
  });

  it('still marks the row ended when the browser leaves while the session is being activated', async () => {
    const run = harness();
    const release: { open?: () => void } = {};
    run.store.gate = new Promise((resolve) => { release.open = resolve; });
    void run.session.start();
    run.session.disconnected();
    release.open?.();
    await settle();
    expect(run.store.ended).toBe('disconnected');
    expect(run.transport.streams).toHaveLength(0);
  });
});

describe('VoiceSession conversation', () => {
  it('forwards the microphone as base64 audioInput, frames sent before the stream opened included', async () => {
    const run = harness();
    run.session.audio(Buffer.from([1, 2, 3, 4]));
    void run.session.start();
    await settle();
    run.session.audio(Buffer.from([5, 6]));
    run.session.audio(Buffer.from([7]));
    await settle();
    expect(run.transport.stream(0).bodies('audioInput').map((body) => body.content)).toStrictEqual(['AQIDBA==', 'BQY=']);
  });

  it('captions both sides and plays the persona\'s audio', async () => {
    const run = await started();
    await personSays(run, 'How was your delivery?');
    const model = run.transport.stream(0);
    model.emit('contentStart', { contentId: 's1', role: 'ASSISTANT', type: 'TEXT', additionalModelFields: '{"generationStage":"SPECULATIVE"}' });
    model.emit('textOutput', { contentId: 's1', role: 'ASSISTANT', content: 'It was late.' });
    model.emit('audioOutput', { contentId: 'a1', content: Buffer.from([9, 9]).toString('base64') });
    await settle();
    expect(run.channel.of('caption')).toStrictEqual([
      { type: 'caption', role: 'user', stage: 'final', text: 'How was your delivery?', turn: 1 },
      { type: 'caption', role: 'assistant', stage: 'speculative', text: 'It was late.', turn: 2 },
    ]);
    expect(run.channel.audioFrames).toStrictEqual([Buffer.from([9, 9])]);
  });

  it('on barge-in says interrupted and drops what the interrupted block still sends', async () => {
    const run = await started();
    const model = run.transport.stream(0);
    model.emit('contentStart', { contentId: 'a1', role: 'ASSISTANT', type: 'AUDIO' });
    model.emit('audioOutput', { contentId: 'a1', content: 'AQI=' });
    model.emit('contentEnd', { contentId: 'a1', stopReason: 'INTERRUPTED', type: 'AUDIO' });
    model.emit('audioOutput', { contentId: 'a1', content: 'AwQ=' });
    await settle();
    expect(run.channel.of('interrupted')).toHaveLength(1);
    expect(run.channel.audioFrames).toHaveLength(1);
  });

  it('answers cite at once and shows only the ids its evidence pack holds', async () => {
    const run = await started();
    run.transport.stream(0).emit('toolUse', { toolName: 'cite', toolUseId: 'tool-1', content: '{"feedback_ids":["fb1","elsewhere"]}' });
    await settle();
    expect(run.channel.of('citation')).toStrictEqual([{ type: 'citation', turn: 1, feedback_ids: ['fb1'] }]);
    expect(run.transport.stream(0).bodies('toolResult').map((body) => body.content)).toStrictEqual(['{"ok":true}']);
  });

  it('writes each settled turn once, as the next write-once part', async () => {
    const run = await started();
    await personSays(run, 'Tell me about support.');
    await personaSays(run, 'Support was kind.');
    expect(run.store.parts.get(1)).toStrictEqual({ version: 1, session_id: SESSION_ID, part: 1, turns: [
      { role: 'user', text: 'Tell me about support.', at: '2026-11-21T12:00:00.000Z', interrupted: false, feedback_ids: [] },
    ] });
    expect(run.store.calls).toContain('recordParts:1');
  });

  it('sends the live cost at most every five seconds', async () => {
    const run = await started();
    const usage = { details: { total: { input: { speechTokens: 1000, textTokens: 0 }, output: { speechTokens: 0, textTokens: 0 } } } };
    run.transport.stream(0).emit('usageEvent', usage);
    run.transport.stream(0).emit('usageEvent', usage);
    await settle();
    expect(run.channel.of('usage')).toStrictEqual([{ type: 'usage', seconds: 0, cents: 0.32 }]);
  });
});

describe('VoiceSession microphone budget', () => {
  it('forwards up to 1.5 times real time (with a second\'s head start) and drops the frames past it', async () => {
    const run = await started();
    const speak = (frames: number) => { Array.from({ length: frames }).forEach(() => { run.session.audio(FRAME); }); };
    speak(40);
    await settle();
    const atStart = run.transport.stream(0).bodies('audioInput').length;
    run.clock.advance(1000);
    speak(40);
    await settle();
    // 48,000 bytes a second: 23 frames of 2,048 in the head start, 46 after one more second.
    expect([atStart, run.transport.stream(0).bodies('audioInput').length]).toStrictEqual([23, 46]);
  });
});

describe('VoiceSession end', () => {
  it('on the person\'s End writes the last turns and the usage, marks the row ended, leaves the live set, then says ended', async () => {
    const run = await started();
    await personSays(run, 'Bye.');
    run.clock.advance(30_000);
    run.session.control('{"type":"end"}');
    await settle();
    expect(run.store.parts.size).toBe(1);
    expect(run.store.usage.at(-1)).toStrictEqual({ seconds: 30, tokens: { speech_in: 0, speech_out: 0, text_in: 0, text_out: 0 }, costMicroUsd: 0, streams: 1 });
    expect([run.store.ended, run.store.calls.at(-1)]).toStrictEqual(['ended_by_person', `leaveLive:${SESSION_ID}`]);
    expect([run.channel.messages.at(-1), run.channel.closedWith]).toStrictEqual([{ type: 'ended', reason: 'ended_by_person' }, 1000]);
  });

  it('ignores a control message that is not End', async () => {
    const run = await started();
    run.session.control('not json');
    run.session.control('{"type":"pause"}');
    await settle();
    expect(run.channel.of('ended')).toStrictEqual([]);
  });

  it('ends with disconnected when the browser leaves, and closes the model stream', async () => {
    const run = await started();
    run.session.disconnected();
    await settle();
    expect(run.store.ended).toBe('disconnected');
    expect(run.transport.stream(0).names().slice(-3)).toStrictEqual(['contentEnd', 'promptEnd', 'sessionEnd']);
  });

  it('ends with busy when the stream fails with a throttling error mid-session, and with error when it just stops', async () => {
    const busy = await started();
    busy.transport.stream(0).fail(named('ModelStreamErrorException'));
    const stopped = await started();
    stopped.transport.stream(0).output.end();
    await settle();
    expect(busy.channel.of('ended')).toStrictEqual([{ type: 'ended', reason: 'busy' }]);
    expect(stopped.channel.of('ended')).toStrictEqual([{ type: 'ended', reason: 'error' }]);
  });
});

describe('VoiceSession limits', () => {
  it('meters each minute, and at the month\'s budget asks the persona for a goodbye and ends at its turn', async () => {
    const run = await started();
    run.store.monthTotal = 18_000 - 30;
    run.clock.advance(MINUTE);
    await settle();
    expect(run.store.monthly).toStrictEqual([{ key: 'VOICEUSE#DEPLOYMENT#2026-11', seconds: 60, cost: 0 }]);
    expect(run.channel.of('notice')).toStrictEqual([{ type: 'notice', code: 'wrapping_up' }]);
    expect(run.transport.stream(0).bodies('textInput').at(-1)?.content).toBe(GOODBYE_TURN);
    await personaSays(run, 'Goodbye!');
    expect(run.channel.of('ended')).toStrictEqual([{ type: 'ended', reason: 'budget' }]);
  });

  it('warns once when a minute is left in the month', async () => {
    const run = await started();
    run.store.monthTotal = 18_000 - 60 - 100;
    run.clock.advance(MINUTE);
    await settle();
    run.clock.advance(MINUTE);
    await settle();
    expect(run.channel.of('budget').map((message) => message.minutes_left)).toStrictEqual([1.7, 0.7]);
    expect(run.channel.of('notice')).toStrictEqual([{ type: 'notice', code: 'budget_almost_up' }]);
  });

  it('warns a minute before the session\'s limit and ends at the wrap-up deadline when the persona does not finish', async () => {
    const run = await started(sessionInput({ session_seconds: 120 }));
    run.clock.advance(MINUTE);
    await settle();
    run.clock.advance(MINUTE);
    await settle();
    expect(run.channel.of('notice').map((notice) => notice.code)).toStrictEqual(['time_almost_up', 'wrapping_up']);
    run.clock.advance(10_000);
    await settle();
    expect(run.channel.of('ended')).toStrictEqual([{ type: 'ended', reason: 'session_limit' }]);
  });
});

describe('VoiceSession cost caps', () => {
  const usage = (speech: number) => ({ details: { total: { input: { speechTokens: 0, textTokens: 0 }, output: { speechTokens: speech, textTokens: 0 } } } });

  it('wraps up with cost_limit, never the month\'s budget nor the time limit, once the session\'s cost reaches its cap', async () => {
    const run = await started(sessionInput({ session_cost_cap_microusd: 12_000 }));
    run.transport.stream(0).emit('usageEvent', usage(900));
    await settle();
    expect(run.channel.of('notice')).toStrictEqual([]);
    run.clock.advance(5000);
    run.transport.stream(0).emit('usageEvent', usage(1000));
    await personaSays(run, 'Goodbye!');
    expect(run.channel.of('notice')).toStrictEqual([{ type: 'notice', code: 'wrapping_up' }]);
    // Q4 (7.71.02): the session's own cost cap has its own reason (the browser words `budget` as this month's minutes
    // used up, and `session_limit` as the time limit).
    expect(run.channel.of('ended')).toStrictEqual([{ type: 'ended', reason: 'cost_limit' }]);
  });

  it('stops the month on its cost cap as well as its minutes', async () => {
    const run = await started(sessionInput({ monthly_cost_cap_microusd: 50_000 }));
    run.store.monthCost = 49_000;
    run.transport.stream(0).emit('usageEvent', usage(100));
    await settle();
    run.clock.advance(MINUTE);
    await settle();
    expect(run.channel.of('budget')).toStrictEqual([{ type: 'budget', minutes_left: 0 }]);
    expect(run.channel.of('notice')).toStrictEqual([{ type: 'notice', code: 'wrapping_up' }]);
  });
});

describe('VoiceSession wrap-up and the meter', () => {
  it('lets an answer under way finish, and ends at the goodbye\'s own finished turn', async () => {
    const run = await started(sessionInput({ session_seconds: 60 }));
    const model = run.transport.stream(0);
    model.emit('completionStart', { completionId: 'c-answer' });
    model.emit('contentStart', { contentId: 'a-answer', role: 'ASSISTANT', type: 'AUDIO' });
    await settle();
    run.clock.advance(MINUTE);
    model.emit('contentEnd', { contentId: 'a-answer', stopReason: 'END_TURN', type: 'AUDIO' });
    await settle();
    expect([run.channel.of('notice').map((notice) => notice.code), run.channel.of('ended')]).toStrictEqual([['wrapping_up'], []]);
    await personaSays(run, 'Goodbye!');
    expect(run.channel.of('ended')).toStrictEqual([{ type: 'ended', reason: 'session_limit' }]);
  });

  it('adds a minute\'s delta to the month once when the end comes while that minute is still being written', async () => {
    const run = await started();
    const release: { open?: () => void } = {};
    run.store.usageGate = new Promise((resolve) => { release.open = resolve; });
    run.clock.advance(MINUTE);
    run.session.control('{"type":"end"}');
    release.open?.();
    await settle();
    expect(run.store.monthly.map((month) => month.seconds)).toStrictEqual([60, 0]);
  });

  it('still adds the minute to the month when the session row is gone, then ends with error', async () => {
    const run = await started();
    run.store.gone = true;
    run.clock.advance(MINUTE);
    await settle();
    expect(run.store.monthly.map((month) => month.seconds)).toStrictEqual([60, 0]);
    expect(run.channel.of('ended')).toStrictEqual([{ type: 'ended', reason: 'error' }]);
  });

  it('ends with error when the session row is gone (its project deleted), and never makes it again', async () => {
    const run = await started();
    run.store.gone = true;
    await personSays(run, 'Hello?');
    await personaSays(run, 'Hi.');
    expect(run.channel.of('ended')).toStrictEqual([{ type: 'ended', reason: 'error' }]);
    expect(run.channel.closedWith).toBe(1011);
  });
});

describe('VoiceSession rollover', () => {
  it('waits for a finished turn after 7 minutes, then replays the conversation into a new stream and closes the old one', async () => {
    const run = await started(sessionInput({ session_seconds: 900 }));
    await personSays(run, 'What frustrates you?');
    await personaSays(run, 'Late parcels.');
    expect(run.transport.streams).toHaveLength(1);
    run.clock.advance(7 * MINUTE);
    await settle();
    await personaSays(run, 'Really late.');
    expect(run.transport.streams).toHaveLength(2);
    expect(run.transport.stream(1).bodies('textInput').slice(1).map((body) => body.content))
      .toStrictEqual(['What frustrates you?', 'Late parcels. Really late.']);
    expect(run.transport.stream(0).inputEnded).toBe(true);
  });

  it('rolls over at 7:45 whatever the persona is doing, and the meter sums both streams', async () => {
    const run = await started();
    const usage = (speech: number) => ({ details: { total: { input: { speechTokens: speech, textTokens: 0 }, output: { speechTokens: 0, textTokens: 0 } } } });
    run.transport.stream(0).emit('usageEvent', usage(100));
    run.clock.advance(7 * MINUTE + 45_000);
    await settle();
    run.transport.stream(1).emit('usageEvent', usage(40));
    await settle();
    run.session.control('{"type":"end"}');
    await settle();
    expect(run.transport.streams).toHaveLength(2);
    expect(run.store.usage.at(-1)?.tokens.speech_in).toBe(140);
    expect(run.store.usage.at(-1)?.streams).toBe(2);
  });

  it('keeps the persona\'s planned words of the turn its old stream never confirmed', async () => {
    const run = await started();
    await personSays(run, 'And then?');
    const model = run.transport.stream(0);
    const segment = (id: string, stage: string, text: string) => {
      model.emit('contentStart', { contentId: id, role: 'ASSISTANT', type: 'TEXT', additionalModelFields: `{"generationStage":"${stage}"}` });
      model.emit('textOutput', { contentId: id, role: 'ASSISTANT', content: text });
    };
    segment('s1', 'SPECULATIVE', 'It came late.');
    segment('f1', 'FINAL', 'It came late.');
    segment('s2', 'SPECULATIVE', 'On day nine.');
    await settle();
    run.clock.advance(7 * MINUTE + 45_000);
    await settle();
    expect(run.transport.stream(1).bodies('textInput').slice(1).map((body) => body.content))
      .toStrictEqual(['And then?', 'It came late. On day nine.']);
  });

  it('ends with error when the new stream does not open', async () => {
    const run = await started();
    run.transport.openError = named('ValidationException');
    run.clock.advance(7 * MINUTE + 45_000);
    await settle();
    expect(run.channel.of('ended')).toStrictEqual([{ type: 'ended', reason: 'error' }]);
  });
});
