import { describe, expect, it } from 'vitest';

import { centsOf, Meter, pricesFor } from './meter.js';

describe('pricesFor', () => {
  it('reads the model\'s figures in its region', () => {
    expect(pricesFor('amazon.nova-2-5-sonic', 'us-west-2')).toStrictEqual({ speech_in: 0.0031832, speech_out: 0.0127329, text_in: 0.000319, text_out: 0.002651 });
  });

  it('prices a region with no figure at the dearest listed, part by part, and another model as 2.5', () => {
    expect(pricesFor('amazon.nova-2-sonic-v1:0', 'ap-northeast-1')).toStrictEqual({ speech_in: 0.003, speech_out: 0.012, text_in: 0.000363, text_out: 0.002992 });
    expect(pricesFor('amazon.other', 'us-east-1')).toStrictEqual(pricesFor('amazon.nova-2-5-sonic', 'us-east-1'));
  });
});

describe('Meter', () => {
  it('keeps each stream\'s last totals and sums the streams', () => {
    const meter = new Meter(pricesFor('amazon.nova-2-5-sonic', 'us-west-2'));
    meter.record(0, { speech_in: 10, speech_out: 0, text_in: 0, text_out: 0 });
    meter.record(0, { speech_in: 157, speech_out: 143, text_in: 953, text_out: 41 });
    meter.record(1, { speech_in: 3, speech_out: 7, text_in: 0, text_out: 0 });
    expect(meter.tokens()).toStrictEqual({ speech_in: 160, speech_out: 150, text_in: 953, text_out: 41 });
  });

  it('prices the tokens in micro-dollars (the spike\'s probe: about a third of a cent)', () => {
    const meter = new Meter(pricesFor('amazon.nova-2-5-sonic', 'us-west-2'));
    meter.record(0, { speech_in: 157, speech_out: 143, text_in: 953, text_out: 41 });
    expect(meter.costMicroUsd()).toBe(2733);
    expect(centsOf(meter.costMicroUsd())).toBeCloseTo(0.27, 6);
  });
});
