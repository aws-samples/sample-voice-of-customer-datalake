import { describe, expect, it } from 'vitest';

import { parseSessionInput } from './session-input.js';
import { PROJECT_ID, SESSION_ID, sessionInput } from './voice-fixtures.js';

describe('parseSessionInput', () => {
  it('reads the persona, its pack, the voice and the limits', () => {
    const input = parseSessionInput(sessionInput(), SESSION_ID, PROJECT_ID);
    expect(input?.evidence.map((item) => item.feedback_id)).toStrictEqual(['fb1', 'fb2']);
    expect([input?.voiceId, input?.voiceGender, input?.sessionSeconds, input?.usageKey])
      .toStrictEqual(['tiffany', 'feminine', 900, 'VOICEUSE#DEPLOYMENT#2026-11']);
    expect([input?.sessionCostCapMicroUsd, input?.monthlyCostCapMicroUsd]).toStrictEqual([750_000, 15_000_000]);
  });

  it('refuses an input for another session or another scope', () => {
    expect(parseSessionInput(sessionInput(), 'ffffffff-d9cb-469f-a165-70867728950e', PROJECT_ID)).toBeUndefined();
    expect(parseSessionInput(sessionInput(), SESSION_ID, 'proj_2')).toBeUndefined();
  });

  it('refuses a voice the model does not have, a limit above 20 minutes and a malformed usage key', () => {
    expect(parseSessionInput(sessionInput({ voice_id: 'brian' }), SESSION_ID, PROJECT_ID)).toBeUndefined();
    expect(parseSessionInput(sessionInput({ session_seconds: 1500 }), SESSION_ID, PROJECT_ID)).toBeUndefined();
    expect(parseSessionInput(sessionInput({ usage_key: 'METRIC#x' }), SESSION_ID, PROJECT_ID)).toBeUndefined();
    expect(parseSessionInput(sessionInput({ session_cost_cap_microusd: undefined }), SESSION_ID, PROJECT_ID)).toBeUndefined();
  });

  it('drops unreadable evidence and defaults an unreadable language to English', () => {
    const input = parseSessionInput(sessionInput({ evidence: [{ text: 'no id' }, { feedback_id: 'fb9' }], language: 'english' }), SESSION_ID, PROJECT_ID);
    expect(input?.evidence.map((item) => item.feedback_id)).toStrictEqual(['fb9']);
    expect(input?.language).toBe('en');
  });
});
