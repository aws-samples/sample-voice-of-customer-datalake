import { describe, expect, it } from 'vitest';

import { parseEmailSender } from './email-sender';

describe('parseEmailSender (-c emailFrom)', () => {
  it.each([undefined, null, ''])('%s is off', (raw) => {
    expect(parseEmailSender(raw)).toBeUndefined();
  });

  it.each([
    ['noreply@voc.example.com', { address: 'noreply@voc.example.com', domain: 'voc.example.com' }],
    ['  No.Reply+board@Voc.Example.COM ', { address: 'No.Reply+board@voc.example.com', domain: 'voc.example.com' }],
  ])('%s parses', (raw, expected) => {
    expect(parseEmailSender(raw)).toStrictEqual(expected);
  });

  it.each([
    'noreply', '@voc.example.com', 'noreply@', 'a@b@voc.example.com', 'noreply@localhost',
    'VoC <noreply@voc.example.com>', 'no..reply@voc.example.com', '.noreply@voc.example.com',
    'noreply@-voc.example.com', `${'a'.repeat(65)}@voc.example.com`, true, 42,
  ])('%s is refused at synth', (raw) => {
    expect(() => parseEmailSender(raw)).toThrow(/-c emailFrom must be a plain address/);
  });
});
