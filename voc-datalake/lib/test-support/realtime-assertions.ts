/**
 * Test support: the check every realtime publisher outside VocApiStack shares (lib/utils/realtime.ts
 * `wireRealtimeEndpointParameter`): its role reads the Event API endpoint parameter, and nothing else in SSM.
 */
import { expect } from 'vitest';
import { realtimeParameterName } from '../utils/realtime';
import type { NormalizedStatement } from './iam-statements';

/** `statements` (a role's, from `roleStatements`) grant exactly `ssm:GetParameter`, on the unprefixed endpoint parameter. */
export function expectReadsOnlyTheRealtimeParameter(statements: readonly NormalizedStatement[]): void {
  const ssm = statements.filter((s) => s.actions.some((a) => a.startsWith('ssm:')));
  expect(ssm.map((s) => s.actions)).toStrictEqual([['ssm:GetParameter']]);
  expect(ssm[0]?.resource).toContain(`parameter${realtimeParameterName(undefined)}`);
}
