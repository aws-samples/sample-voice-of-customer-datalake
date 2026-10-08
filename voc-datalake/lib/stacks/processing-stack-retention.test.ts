/**
 * voc-retention — the per-source retention / erasure worker (retention-worker.ts,
 * docs/source-policies.md). The one role allowed to delete customer data, so its
 * grants are pinned EXACTLY: any widening (a Put on feedback, a bucket-wide delete,
 * a delete on aggregates) fails here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { itemAt } from '../test-support/guards';
import { allowedActions, roleStatements } from '../test-support/iam-statements';
import { byCodeUnit } from '../utils/compare';
import { expectSelfInvokeOnly, findWorkerFunction } from '../test-support/worker-function';

const RuleSchema = z.object({
  Properties: z.object({
    ScheduleExpression: z.string(),
    Targets: z.array(z.object({ Input: z.string().optional() })),
  }),
});

let template: Template;
beforeAll(() => { template = synthProcessingTemplate({ withIndexes: true }); });

const worker = () => findWorkerFunction(template, 'voc-retention-');

const statements = () => roleStatements(template, worker().Role['Fn::GetAtt'][0]);

describe('voc-retention worker', () => {
  it('runs the contract handler with a 15-minute ceiling and no hidden re-drive', () => {
    expect(worker().Handler).toBe('jobs/retention/handler.lambda_handler');
    expect(worker().Timeout).toBe(900);
    const functionId = Object.keys(template.findResources('AWS::Lambda::Function'))
      .filter((id) => id.startsWith('RetentionWorkerRetention'));
    const config = Object.values(template.findResources('AWS::Lambda::EventInvokeConfig'))
      .filter((c) => JSON.stringify(c).includes(`"Ref":"${itemAt(functionId, 0)}"`));
    expect(JSON.stringify(config)).toContain('"MaximumRetryAttempts":0');
  });

  it('is handed both tables, the raw bucket and its own name', () => {
    expect(Object.keys(worker().Environment.Variables)).toStrictEqual(expect.arrayContaining([
      'FEEDBACK_TABLE', 'AGGREGATES_TABLE', 'RAW_DATA_BUCKET', 'RETENTION_FUNCTION',
    ]));
    expect(JSON.stringify(worker().Environment.Variables.RETENTION_FUNCTION)).toContain('voc-retention-');
  });

  it('holds exactly GetItem/Query/Scan/DeleteItem on feedback — never Put, Update or BatchWrite', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'Feedback'))
      .toStrictEqual(['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan']);
  });

  it('holds exactly GetItem/PutItem/UpdateItem/Query on aggregates — never a delete', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'Aggregates'))
      .toStrictEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
  });

  it('deletes objects and versions under raw/* only, and lists versions of raw/ only', () => {
    const s3 = statements().filter((s) => s.effect === 'Allow' && s.actions.some((a) => a.startsWith('s3:')));
    expect(s3.map((s) => [...s.actions].sort(byCodeUnit).join(','))).toStrictEqual([
      's3:DeleteObject,s3:DeleteObjectVersion',
      's3:ListBucketVersions',
    ]);
    expect(itemAt(s3, 0).resource).toContain('/raw/*');
    expect(JSON.stringify(template.toJSON())).toContain('"s3:prefix":["raw/*"]');
  });

  it('is explicitly denied every object delete on the whole-upload archives', () => {
    const denies = statements().filter((s) => s.effect === 'Deny');
    expect(denies.map((s) => s.actions)).toStrictEqual([['s3:DeleteObject*']]);
    expect(itemAt(denies, 0).resource).toContain('/raw/csv_upload/*');
    expect(itemAt(denies, 0).resource).toContain('/raw/json_upload/*');
  });

  it('may invoke only itself, by an unqualified colon-form ARN', () => {
    expectSelfInvokeOnly(statements(), 'voc-retention-');
    expect(statements().filter((s) => s.actions.includes('lambda:InvokeFunction') && s.resource.includes('*'))).toStrictEqual([]);
  });

  it('cannot reach Bedrock, SQS, other tables or anything with a wildcard action', () => {
    const offenders = statements().filter((s) => s.actions.some((a) =>
      a.startsWith('bedrock:') || a.startsWith('sqs:') || a.endsWith(':*'))
      || ['Projects', 'Jobs', 'Memory', 'Agents', 'Conversations'].some((t) => s.resource.includes(t)));
    expect(offenders).toStrictEqual([]);
  });

  it('runs daily in retention mode', () => {
    const rules = Object.entries(template.findResources('AWS::Events::Rule'))
      .filter(([id]) => id.startsWith('RetentionWorkerRetentionSchedule'))
      .map(([, rule]) => RuleSchema.parse(rule).Properties);
    expect(rules).toHaveLength(1);
    expect(itemAt(rules, 0).ScheduleExpression).toBe('cron(15 4 * * ? *)');
    expect(JSON.parse(itemAt(itemAt(rules, 0).Targets, 0).Input ?? '{}')).toStrictEqual({ mode: 'retention' });
  });
});
