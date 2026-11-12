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

  it('is handed both tables and the raw bucket, but not its own name (it re-invokes via context.function_name)', () => {
    const variables = worker().Environment.Variables;
    expect(Object.keys(variables)).toStrictEqual(expect.arrayContaining([
      'FEEDBACK_TABLE', 'AGGREGATES_TABLE', 'RAW_DATA_BUCKET', 'RADAR_TABLE', 'PROJECTS_TABLE', 'FEATURE_REQUESTS_TABLE',
    ]));
    expect(variables).not.toHaveProperty('RETENTION_FUNCTION');
  });

  it('holds exactly GetItem/Query/Scan/DeleteItem on feedback — never Put, Update or BatchWrite', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'Feedback'))
      .toStrictEqual(['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan']);
  });

  it('holds exactly Get/Put/Update/Query plus the tombstone batches on aggregates — never a delete', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'Aggregates')).toStrictEqual([
      'dynamodb:BatchGetItem', 'dynamodb:GetItem', 'dynamodb:PutItem',
      'dynamodb:Query', 'dynamodb:UpdateItem',
    ]);
  });

  it('holds exactly Scan/DeleteItem on radar, plus the version bump pinned to SETTINGS#radar', () => {
    const radar = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('Radar')
      && s.actions.some((a) => a.startsWith('dynamodb:')));
    expect(radar.map((s) => [...s.actions].sort(byCodeUnit).join(','))).toStrictEqual([
      'dynamodb:DeleteItem,dynamodb:Scan', 'dynamodb:UpdateItem',
    ]);
    expect(JSON.stringify(template.toJSON())).toContain('"dynamodb:LeadingKeys":["SETTINGS#radar"]');
  });

  it('holds exactly Scan/UpdateItem on projects — it marks artifacts, never deletes or puts', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'Projects')).toStrictEqual(['dynamodb:Scan', 'dynamodb:UpdateItem']);
  });

  it('reads and updates feature requests, and puts / deletes only under FR#* (it re-keys an erased +1)', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'FeatureRequests')).toStrictEqual([
      'dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:Scan',
      'dynamodb:UpdateItem',
    ]);
    const writes = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('FeatureRequests')
      && s.actions.some((a) => a === 'dynamodb:PutItem' || a === 'dynamodb:DeleteItem'));
    expect(writes.map((s) => [...s.actions].sort(byCodeUnit).join(','))).toStrictEqual(['dynamodb:DeleteItem,dynamodb:PutItem']);
    expect(JSON.stringify(template.toJSON())).toContain('"dynamodb:LeadingKeys":["FR#*"]');
    // A wildcard needs a StringLike-family operator: StringEquals would deny every re-key at runtime.
    expect(JSON.stringify(template.toJSON())).toContain('"ForAllValues:StringLike":{"dynamodb:LeadingKeys":["FR#*"]}');
  });

  it('scans workspaces and updates only email and name under WS#* (it de-identifies membership rows)', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'Workspaces')).toStrictEqual(['dynamodb:Scan', 'dynamodb:UpdateItem']);
    const update = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('Workspaces')
      && s.actions.includes('dynamodb:UpdateItem'));
    expect(update.map((s) => s.actions)).toStrictEqual([['dynamodb:UpdateItem']]);
    expect(JSON.stringify(template.toJSON())).toContain(
      '{"ForAllValues:StringLike":{"dynamodb:LeadingKeys":["WS#*"]},'
      + '"ForAllValues:StringEquals":{"dynamodb:Attributes":["email","name","pk","sk"]}}');
    expect(worker().Environment.Variables).toHaveProperty('WORKSPACES_TABLE');
  });

  it('deletes objects and versions under raw/* and silver/* only, and lists versions of those prefixes only', () => {
    const s3 = statements().filter((s) => s.effect === 'Allow' && s.actions.some((a) => a.startsWith('s3:')));
    expect(s3.map((s) => [...s.actions].sort(byCodeUnit).join(','))).toStrictEqual([
      's3:DeleteObject,s3:DeleteObjectVersion',
      's3:ListBucketVersions',
    ]);
    expect(itemAt(s3, 0).resource).toContain('/raw/*');
    expect(itemAt(s3, 0).resource).toContain('/silver/*');
    expect(JSON.stringify(template.toJSON())).toContain('"s3:prefix":["raw/*","silver/*"]');
  });

  it('carries no Deny of its own: whole-file uploads are reached only by a whole-source erasure (in code)', () => {
    expect(statements().filter((s) => s.effect === 'Deny')).toStrictEqual([]);
  });

  it('may invoke only itself, by an unqualified colon-form ARN', () => {
    expectSelfInvokeOnly(statements(), 'voc-retention-');
    expect(statements().filter((s) => s.actions.includes('lambda:InvokeFunction') && s.resource.includes('*'))).toStrictEqual([]);
  });

  it('cannot reach Bedrock, SQS, other tables or anything with a wildcard action', () => {
    const offenders = statements().filter((s) => s.actions.some((a) =>
      a.startsWith('bedrock:') || a.startsWith('sqs:') || a.endsWith(':*'))
      || ['Jobs', 'Memory', 'Agents', 'Conversations'].some((t) => s.resource.includes(t)));
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
