import { describe, expect, it } from 'vitest';

import { inferenceScopeEnv, parseInferenceScope } from './inference-scope';

describe('parseInferenceScope', () => {
  it.each([undefined, null, ''])('defaults %s to global', (raw) => {
    expect(parseInferenceScope(raw)).toBe('global');
  });

  it.each(['global', 'eu'])('accepts %s', (raw) => {
    expect(parseInferenceScope(raw)).toBe(raw);
  });

  it.each(['EU', 'us', 'eu-central-1', true, 1])('throws on %s', (raw) => {
    expect(() => parseInferenceScope(raw)).toThrow(/Invalid -c inferenceScope=/);
  });
});

describe('inferenceScopeEnv', () => {
  it('adds nothing for global, so a default deployment is unchanged', () => {
    expect(inferenceScopeEnv('global')).toStrictEqual({});
  });

  it('maps inference to eu. and disables avatars for eu', () => {
    expect(inferenceScopeEnv('eu')).toStrictEqual({ BEDROCK_INFERENCE_SCOPE: 'eu', AVATARS_ENABLED: 'false' });
  });
});
