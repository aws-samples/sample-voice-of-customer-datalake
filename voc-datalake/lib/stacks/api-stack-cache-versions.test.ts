/**
 * The read cache's IAM and CORS (docs/caching.md, lambda/shared/data_version.py,
 * lambda/shared/http_cache.py).
 *
 * Writers that otherwise only read a table bump a cache version with ONE UpdateItem,
 * and that grant is pinned to the version rows' partition by `dynamodb:LeadingKeys`,
 * so it cannot write anything else. The Radar API reads every version in one
 * BatchGetItem across both tables. `ETag` is exposed to the SPA.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { apiTemplate, policyStatementsOf } from '../test-support/api-stack-template';
import type { RolePolicyStatement } from '../test-support/api-stack-template';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { findWorkerFunction } from '../test-support/worker-function';
import { RenderedStringRecordSchema } from '../test-support/cfn-render';

const LeadingKeysSchema = z.object({
  'ForAllValues:StringEquals': z.object({ 'dynamodb:LeadingKeys': z.array(z.string()) }),
});

/** The partitions every UpdateItem statement on `tableFragment` is pinned to (null = an unconditioned one). */
function updatePartitions(statements: RolePolicyStatement[], tableFragment: string): (string[] | null)[] {
  return statements
    .filter((s) => s.actions.includes('dynamodb:UpdateItem') && s.resource.includes(tableFragment))
    .map((s) => LeadingKeysSchema.safeParse(s.condition).data?.['ForAllValues:StringEquals']['dynamodb:LeadingKeys'] ?? null);
}

let processing: Template;
beforeAll(() => {
  apiTemplate();
  processing = synthProcessingTemplate({ withIndexes: true });
}, SYNTH_TIMEOUT_MS);

describe('cache version bumps are the only aggregates write of read-mostly API roles', () => {
  it.each(['FeedbackEditLambdaRole', 'DataExplorerLambdaRole', 'UsersLambdaRole'])(
    '%s may UpdateItem only the METRIC#meta partition',
    (role) => {
      expect(updatePartitions(policyStatementsOf(apiTemplate(), role), 'Aggregates')).toStrictEqual([['METRIC#meta']]);
    },
  );
});

describe('the Radar API', () => {
  const radarStatements = () => policyStatementsOf(apiTemplate(), 'RadarLambdaRole');

  it('bumps only the SETTINGS#radar partition', () => {
    expect(updatePartitions(radarStatements(), 'Radar')).toStrictEqual([['SETTINGS#radar']]);
  });

  it('reads the versions with BatchGetItem on both tables', () => {
    const batch = radarStatements().filter((s) => s.actions.includes('dynamodb:BatchGetItem'));
    expect(batch.some((s) => s.resource.includes('Radar'))).toBe(true);
    expect(batch.some((s) => s.resource.includes('Aggregates'))).toBe(true);
  });
});

describe('the Radar scan worker', () => {
  it('bumps only the SETTINGS#radar partition', () => {
    const role = findWorkerFunction(processing, 'voc-radar-scan-').Role['Fn::GetAtt'][0];
    // The policy's logical id is the role's path without its 8-hex hash suffix + "DefaultPolicy…".
    const statements = policyStatementsOf(processing, `${role.slice(0, -8)}DefaultPolicy`);
    expect(updatePartitions(statements, 'Radar')).toStrictEqual([['SETTINGS#radar']]);
  });
});

describe('ETag reaches the SPA', () => {
  const GatewayResponseSchema = z.object({
    Properties: z.object({ ResponseParameters: RenderedStringRecordSchema.optional() }),
  });

  it('is in the expose list of every gateway response that publishes one', () => {
    const lists = Object.values(apiTemplate().findResources('AWS::ApiGateway::GatewayResponse'))
      .map((r) => GatewayResponseSchema.parse(r).Properties.ResponseParameters?.['gatewayresponse.header.Access-Control-Expose-Headers'])
      .filter((value): value is string => typeof value === 'string');
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.filter((value) => !value.split(',').map((h) => h.replace(/'/g, '').trim()).includes('ETag'))).toStrictEqual([]);
  });
});
