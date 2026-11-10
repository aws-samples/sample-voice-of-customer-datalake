import { describe, expect, it } from 'vitest';
import { invocationDeadlineMs } from './lambda-deadline.js';

describe('invocationDeadlineMs', () => {
  it('is now plus the remaining time the Lambda context reports', () => {
    const context = { getRemainingTimeInMillis: () => 899_000 };
    expect(invocationDeadlineMs(context, 1_000)).toBe(900_000);
  });

  it('calls the method on the context itself', () => {
    const context = {
      left: 5_000,
      getRemainingTimeInMillis(this: { left: number }) {
        return this.left;
      },
    };
    expect(invocationDeadlineMs(context, 10)).toBe(5_010);
  });

  it.each([
    ['no context', undefined],
    ['a non-object', 'ctx'],
    ['no method', { functionName: 'voc-chat-stream' }],
    ['a non-number answer', { getRemainingTimeInMillis: () => 'soon' }],
    ['a negative answer', { getRemainingTimeInMillis: () => -1 }],
    ['a non-finite answer', { getRemainingTimeInMillis: () => Number.POSITIVE_INFINITY }],
  ])('is undefined for %s', (_label, context) => {
    expect(invocationDeadlineMs(context, 1_000)).toBeUndefined();
  });
});
