/**
 * The logs API per workspace (docs/multi-workspace.md; lambda/api/logs_handler.py): what its role may do in one.
 *
 * Its logs routes resolve the request's workspace (the stack's resolution policy, the live platform-admin check), read
 * that workspace's trail with the role's table reads, and clear a validation trail with one batch of deletes on the
 * deployment's `LOGS#validation#*` rows or one workspace id's `WS#{ws}#LOGS#validation#*`, nothing else; a workspace's
 * clear is audited first, a put on `AUDIT#WS#*` in voc-workspaces only.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { apiTemplate, expectRequestWorkspace, policyStatementsOf } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

const ONE_WORKSPACE = `ws_${'?'.repeat(26)}`;
const LikeSchema = z.object({ 'ForAllValues:StringLike': z.object({ 'dynamodb:LeadingKeys': z.array(z.string()) }) });
const leadingKeys = (condition: unknown) =>
  LikeSchema.safeParse(condition).data?.['ForAllValues:StringLike']['dynamodb:LeadingKeys'] ?? null;

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

describe('the logs API in a workspace', () => {
  const statements = () => policyStatementsOf(apiTemplate(), 'LogsLambdaRole');

  it("deletes only validation trail rows: the deployment's and one workspace id's", () => {
    const deletes = statements().filter((s) => s.actions.includes('dynamodb:BatchWriteItem'));
    expect(deletes.map((s) => [s.actions, leadingKeys(s.condition)]))
      .toStrictEqual([[['dynamodb:BatchWriteItem'], ['LOGS#validation#*', `WS#${ONE_WORKSPACE}#LOGS#validation#*`]]]);
  });

  it("puts only the deployment clear's AUDIT#delete row in voc-aggregates (a workspace clear's is the resolution "
    + "policy's AUDIT#WS#* put)", () => {
    // The stack's one resolution policy (lib/utils/workspace-resolution-grants.ts, its own tests) holds the other put.
    const puts = statements().filter((s) => s.actions.includes('dynamodb:PutItem'));
    expect(puts.map((s) => [s.actions, s.resource.includes('Aggregates'), leadingKeys(s.condition)]))
      .toStrictEqual([[['dynamodb:PutItem'], true, ['AUDIT#delete']]]);
  });

  it("is the AUDIT#delete writer of voc-aggregates for that partition only (lib/utils/audit-row-guard.ts)", () => {
    // The guard's Denies (policyStatementsOf leaves them out): a writer held to its one audit partition.
    const policy = Object.entries(apiTemplate().findResources('AWS::IAM::Policy'))
      .find(([id]) => id.includes('LogsLambdaRole'));
    expect(JSON.stringify(policy)).toContain('DenyAuditRowWritesOutsideOwnPartition');
  });

  it("resolves the request's workspace and live-checks a platform admin's entry", () => {
    expectRequestWorkspace(apiTemplate(), 'LogsLambdaRole', 'voc-logs-api');
  });
});
