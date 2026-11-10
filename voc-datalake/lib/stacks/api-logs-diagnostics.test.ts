/**
 * CORE_LAMBDA_LOG_GROUPS (api-logs-diagnostics.ts) in lockstep with the synthesized VocCoreStack:
 * every application Lambda there whose log group CloudFormation names (no LogGroupName) is listed,
 * and nothing else is. CDK provider handlers (`*Provider*`, the stack-named singletons) are not app
 * code and are left out on purpose. The board-pool triggers exist on every deployment since 5.45.00.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SYNTH_TIMEOUT_MS, synthApp } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { CORE_LAMBDA_LOG_GROUPS, queueNamesOf } from './api-logs-diagnostics';

const Resources = z.record(z.string(), z.object({
  Type: z.string(),
  Properties: z.record(z.string(), z.unknown()).optional(),
}));
const LoggingConfig = z.object({ LogGroup: z.object({ Ref: z.string() }) });
const LOGICAL_ID_HASH = /[0-9A-F]{8}$/;

/** Construct ids of VocCoreStack's unnamed log groups that an application Lambda writes to. */
function cfnNamedAppLambdaGroups(context: Record<string, unknown>): string[] {
  const resources = Resources.parse(synthApp(context).template('VocCoreStack').Resources);
  const ids = Object.values(resources)
    .filter((r) => r.Type === 'AWS::Lambda::Function')
    .map((r) => LoggingConfig.safeParse(r.Properties?.LoggingConfig))
    .flatMap((parsed) => (parsed.success ? [parsed.data.LogGroup.Ref] : []))
    .filter((ref) => resources[ref]?.Type === 'AWS::Logs::LogGroup' && resources[ref].Properties?.LogGroupName === undefined)
    .filter((ref) => !ref.includes('Provider') && !ref.startsWith('VocCoreStack'))
    .map((ref) => ref.replace(LOGICAL_ID_HASH, ''));
  return [...new Set(ids)].sort(byCodeUnit);
}

describe('CORE_LAMBDA_LOG_GROUPS', () => {
  it('names every CloudFormation-named application Lambda log group of the default VocCoreStack', () => {
    expect(cfnNamedAppLambdaGroups({})).toStrictEqual(Object.values(CORE_LAMBDA_LOG_GROUPS).sort(byCodeUnit));
  }, SYNTH_TIMEOUT_MS * 2);

  it('names the same groups with -c emailFrom (it changes how the board pool emails, not which triggers exist)', () => {
    expect(cfnNamedAppLambdaGroups({ emailFrom: 'noreply@voc.example.com' }))
      .toStrictEqual(Object.values(CORE_LAMBDA_LOG_GROUPS).sort(byCodeUnit));
  }, SYNTH_TIMEOUT_MS * 2);
});

describe('queueNamesOf', () => {
  it('reads the queue names out of OPS_ALERTS_QUEUES', () => {
    expect(queueNamesOf('processing-dlq=voc-processing-dlq-1,briefing-dlq=voc-briefing-dlq-1,broken'))
      .toStrictEqual(['voc-processing-dlq-1', 'voc-briefing-dlq-1']);
    expect(queueNamesOf('')).toStrictEqual([]);
  });
});
