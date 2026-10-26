/**
 * `-c protectData` parsing: off unless explicitly true, and a typo fails the synth.
 */
import * as cdk from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { dataProtection, shouldProtectData } from './data-protection';

describe('shouldProtectData', () => {
  it.each([undefined, null, false, 'false', ' FALSE '])('leaves data deletable with the stack for %j', (value) => {
    expect(shouldProtectData(value)).toBe(false);
  });

  it.each([true, 'true', ' True '])('protects data for %j', (value) => {
    expect(shouldProtectData(value)).toBe(true);
  });

  it.each(['ture', 'yes', '1', 1, {}])('refuses %j instead of silently deploying unprotected', (value) => {
    expect(() => shouldProtectData(value)).toThrow(/Unrecognized protectData context value/);
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
