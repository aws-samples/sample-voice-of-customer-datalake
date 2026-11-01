/**
 * `-c protectData` parsing: on unless explicitly false (since 5.73.00), and a typo fails the synth.
 */
import * as cdk from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { dataProtection, shouldProtectData } from './data-protection';

describe('shouldProtectData', () => {
  it.each([false, 'false', ' FALSE '])('leaves data deletable with the stack for %j', (value) => {
    expect(shouldProtectData(value)).toBe(false);
  });

  it.each([undefined, null, true, 'true', ' True '])('protects data for %j (the default when absent)', (value) => {
    expect(shouldProtectData(value)).toBe(true);
  });

  it.each(['ture', 'flase', 'yes', '1', 1, {}])('refuses %j instead of guessing', (value) => {
    expect(() => shouldProtectData(value)).toThrow(/Unrecognized protectData context value/);
  });

  it('tells a demo how to opt out in its error message', () => {
    expect(() => shouldProtectData('nope')).toThrow(/-c protectData=false/);
  });
});

describe('dataProtection', () => {
  it('keeps data on deletion and replacement, with deletion protection and no auto-delete, when on', () => {
    expect(dataProtection(true)).toStrictEqual({
      removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      deletionProtection: true,
      autoDeleteObjects: false,
    });
  });

  it('deletes data with the stack and renders no deletion protection when off', () => {
    expect(dataProtection(false)).toStrictEqual({
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: undefined,
      autoDeleteObjects: true,
    });
  });
});
