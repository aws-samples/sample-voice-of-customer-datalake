import { describe, expect, it } from 'vitest';
import {
  ASSIST_DEADLINE_MARGIN_MS,
  ASSIST_POLL_CAP_MS,
  ASSIST_POLL_INTERVAL_MS,
  awaitAssistJob,
  type AssistJobClock,
} from './assist-job.js';

/** A clock that advances only when the poller sleeps. */
function steppingClock(start = 0): AssistJobClock & { sleeps: number[] } {
  const state = { now: start, sleeps: [] as number[] };
  return {
    sleeps: state.sleeps,
    nowMs: () => state.now,
    sleep: (ms) => {
      state.sleeps.push(ms);
      state.now += ms;
      return Promise.resolve();
    },
  };
}

const STARTED = { success: true, job_id: 'job_1', status: 'pending' };
const pending = () => Promise.resolve({ status: 'pending' });

describe('awaitAssistJob', () => {
  it('resolves the completed job result after one interval', async () => {
    const clock = steppingClock();
    const polled: string[] = [];
    const result = await awaitAssistJob(clock, {
      started: STARTED,
      poll: (id) => {
        polled.push(id);
        return Promise.resolve({ status: 'completed', result: { answers: ['a'] } });
      },
      label: 'The work',
    });
    expect(result).toStrictEqual({ answers: ['a'] });
    expect(polled).toStrictEqual(['job_1']);
    expect(clock.sleeps).toStrictEqual([ASSIST_POLL_INTERVAL_MS]);
  });

  it('throws the failed job error, clipped', async () => {
    const wait = { started: STARTED, poll: () => Promise.resolve({ status: 'failed', error: 'x'.repeat(500) }), label: 'The work' };
    const error: unknown = await awaitAssistJob(steppingClock(), wait).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'unavailable' });
    expect(error instanceof Error && error.message.length < 260).toBe(true);
  });

  it('says only "failed." when the job carries no error text', async () => {
    const wait = { started: STARTED, poll: () => Promise.resolve({ status: 'failed', error: null }), label: 'The work' };
    await expect(awaitAssistJob(steppingClock(), wait)).rejects.toMatchObject({ message: 'The work failed.' });
  });

  it('gives up at the cap when no deadline is known', async () => {
    const clock = steppingClock();
    await expect(awaitAssistJob(clock, { started: STARTED, poll: pending, label: 'The work' }))
      .rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('taking too long') });
    expect(clock.nowMs()).toBeLessThanOrEqual(ASSIST_POLL_CAP_MS);
    expect(clock.nowMs()).toBeGreaterThan(ASSIST_POLL_CAP_MS - ASSIST_POLL_INTERVAL_MS * 2);
  });

  it('gives up a margin before the invocation deadline', async () => {
    const clock = steppingClock();
    const deadlineMs = 120_000;
    await expect(awaitAssistJob(clock, { started: STARTED, poll: pending, deadlineMs, label: 'The work' })).rejects.toMatchObject({ code: 'unavailable' });
    expect(clock.nowMs()).toBeLessThanOrEqual(deadlineMs - ASSIST_DEADLINE_MARGIN_MS);
  });

  it.each([
    ['a start without a job id', { success: true, selectors: {} }],
    ['a non-object start', 'ok'],
  ])('refuses %s without polling', async (_label, started) => {
    const polled: string[] = [];
    const poll = (id: string) => {
      polled.push(id);
      return pending();
    };
    await expect(awaitAssistJob(steppingClock(), { started, poll, label: 'The work' }))
      .rejects.toMatchObject({ code: 'unavailable', message: 'The work answered unexpectedly. Try again later.' });
    expect(polled).toStrictEqual([]);
  });

  it('refuses a poll answer with an unknown status', async () => {
    const wait = { started: STARTED, poll: () => Promise.resolve({ status: 'queued' }), label: 'The work' };
    await expect(awaitAssistJob(steppingClock(), wait)).rejects.toMatchObject({ message: 'The work answered unexpectedly. Try again later.' });
  });
});
