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

  it('puts nothing of its own: the audit row of a clear is the resolution policy\'s AUDIT#WS#* put', () => {
    // The stack's one resolution policy (lib/utils/workspace-resolution-grants.ts, its own tests) holds that put.
    expect(statements().filter((s) => s.actions.includes('dynamodb:PutItem'))).toStrictEqual([]);
  });

  it("resolves the request's workspace and live-checks a platform admin's entry", () => {
    expectRequestWorkspace(apiTemplate(), 'LogsLambdaRole', 'voc-logs-api');
  });
});
