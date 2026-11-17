/**
 * The scheduled cross-run Learn pass (engineering-cross-run.ts, 7.53.00): nothing with the module off; with it, one
 * weekly EventBridge Scheduler schedule, DISABLED unless -c engineeringCrossRunLearn=weekly, invoking the runtime
 * through a role of its own that may invoke the runtime and nothing else; on the runtime's role exactly the index's
 * listing by prefix, the manifests' read, the records' create-only put and the cross-run rows by their partitions.
 */
import * as fs from 'fs';
import * as path from 'path';

import { Match, type Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { count, policyText, runtimeStack } from '../test-support/engineering-runtime-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import {
  CROSS_RUN_INDEX_PREFIX, CROSS_RUN_PARTITIONS, CROSS_RUN_RECORD_KEYS, CROSS_RUN_SCHEDULE,
} from './engineering-cross-run';

const StatementsSchema = z.array(z.looseObject({
  Sid: z.string().optional(), Action: z.union([z.string(), z.array(z.string())]), Condition: z.unknown().optional(),
  Resource: z.unknown().optional(),
}));
const ScheduleSchema = z.looseObject({
  State: z.string(), ScheduleExpression: z.string(), ScheduleExpressionTimezone: z.string(),
  FlexibleTimeWindow: z.unknown(), GroupName: z.unknown().optional(),
  Target: z.looseObject({ Arn: z.unknown(), RoleArn: z.unknown(), Input: z.string(), RetryPolicy: z.unknown() }),
});

/** The statements of the policies on the role whose logical id contains `roleId`: its inline ones and the managed
 *  ones CDK moves a long one's overflow into. */
function statements(template: Template, roleId: string): z.infer<typeof StatementsSchema> {
  const attached = { Properties: { Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp(roleId) }]) } };
  return [...Object.values(template.findResources('AWS::IAM::Policy', attached)),
    ...Object.values(template.findResources('AWS::IAM::ManagedPolicy', attached))]
    .flatMap((policy) => StatementsSchema.parse(policy.Properties?.PolicyDocument?.Statement));
}

function schedule(template: Template): z.infer<typeof ScheduleSchema> {
  const [found] = Object.values(template.findResources('AWS::Scheduler::Schedule', {
    Properties: { Name: 'voc-eng-cross-run-learn' },
  }));
  return ScheduleSchema.parse(found?.Properties);
}

const LAMBDA = path.join(__dirname, '../../lambda/engineering');

describe('the scheduled cross-run Learn pass', () => {
  it('adds no schedule, role or grant with the module off', () => {
    const { template } = runtimeStack({});
    expect(count(template, 'AWS::Scheduler::Schedule')).toBe(0);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/CrossRun|learn_cross_run/);
  });

  describe('with -c engineeringAgents=true', () => {
    let template: Template;
    beforeAll(() => {
      ({ template } = runtimeStack({ engineeringAgents: 'true' }));
    }, SYNTH_TIMEOUT_MS);

    it('creates one weekly schedule, DISABLED by default, that invokes the runtime with learn_cross_run and never retries', () => {
      const found = schedule(template);
      expect([found.State, found.ScheduleExpression, found.ScheduleExpressionTimezone, found.GroupName])
        .toStrictEqual(['DISABLED', CROSS_RUN_SCHEDULE, 'UTC', undefined]);
      expect([found.Target.Input, found.Target.RetryPolicy, found.FlexibleTimeWindow]).toStrictEqual([
        '{"action":"learn_cross_run"}', { MaximumRetryAttempts: 0 }, { Mode: 'OFF' }]);
      expect(found.Target.Arn).toStrictEqual({ 'Fn::GetAtt': [expect.stringMatching(/EngineeringSupervisor/), 'Arn'] });
    });

    it('gives the schedule a role of its own that only this schedule assumes and that only invokes the runtime', () => {
      const [role] = Object.entries(template.findResources('AWS::IAM::Role'))
        .filter(([id]) => id.includes('EngineeringCrossRunSchedulerRole')).map(([, found]) => JSON.stringify(found));
      expect([role?.includes('"Service":"scheduler.amazonaws.com"'), role?.includes('"aws:SourceAccount":"111111111111"'),
        role?.includes(':schedule/default/voc-eng-cross-run-learn"')]).toStrictEqual([true, true, true]);
      const invoker = statements(template, 'EngineeringCrossRunSchedulerRole');
      expect(invoker.map((found) => [found.Sid, found.Action])).toStrictEqual([['InvokeTheRuntime', 'lambda:InvokeFunction']]);
      expect(invoker[0]?.Resource).toStrictEqual({ 'Fn::GetAtt': [expect.stringMatching(/EngineeringSupervisor/), 'Arn'] });
    });

    it('lets the runtime list the transcripts\' index by its prefix only, and read the runs\' manifests', () => {
      const own = statements(template, 'EngineeringSupervisorRole');
      const bySid = (sid: string) => own.find((found) => found.Sid === sid);
      expect([bySid('CrossRunListsIndex')?.Action, bySid('CrossRunListsIndex')?.Condition]).toStrictEqual([
        's3:ListBucket', { StringLike: { 's3:prefix': [CROSS_RUN_INDEX_PREFIX] } }]);
      expect(bySid('CrossRunReadsManifests')?.Action).toBe('s3:GetObject');
      expect(JSON.stringify(bySid('CrossRunReadsManifests')?.Resource)).toMatch(/"\/ws\/default\/runs\/\*\/_manifest\/\*"\]/);
    });

    it('lets the runtime put the weekly records under ws/default/learn/ (create-only) and nothing else there', () => {
      const own = statements(template, 'EngineeringSupervisorRole');
      const records = own.find((found) => found.Sid === 'CrossRunRecords');
      expect([records?.Action, JSON.stringify(records?.Resource).includes(`/${CROSS_RUN_RECORD_KEYS}"`)])
        .toStrictEqual(['s3:PutObject', true]);
      expect(policyText(template, 'EngineeringSupervisorRole').match(/ws\/default\/learn\//g)).toHaveLength(1);
      // (create-only is the workspace bucket's own rule: it refuses any put without If-None-Match, core-buckets.ts)
      expect(policyText(template, 'EngineeringSupervisorRole')).not.toMatch(/s3:DeleteObject/);
    });

    it('lets the runtime claim, record and book the flows\' weeks in their own partitions only, never a delete', () => {
      const rows = statements(template, 'EngineeringSupervisorRole').filter((found) => found.Sid === 'CrossRunRows');
      expect(rows.map((found) => [found.Action, found.Condition])).toStrictEqual([[
        ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [CROSS_RUN_PARTITIONS] } }]]);
      expect(policyText(template, 'EngineeringSupervisorRole')).not.toMatch(/dynamodb:DeleteItem[^}]*#LEARN#/);
    });

    it.each(['EngineeringDeliveryRole', 'EngineeringStartRole', 'EngineeringAgentFixerRole', 'SessionRole'])(
      'grants %s nothing of it', (role) => {
        expect(policyText(template, role)).not.toMatch(/CrossRun|#LEARN#|ws\/default\/learn\/|transcripts-index/);
      });
  });

  it('is ENABLED with -c engineeringCrossRunLearn=weekly, and off is the default\'s own word', () => {
    expect(schedule(runtimeStack({ engineeringAgents: 'true', engineeringCrossRunLearn: 'weekly' }).template).State)
      .toBe('ENABLED');
    expect(schedule(runtimeStack({ engineeringAgents: 'true', engineeringCrossRunLearn: 'off' }).template).State)
      .toBe('DISABLED');
  }, SYNTH_TIMEOUT_MS);

  it.each([['daily'], ['true'], ['on']])('refuses -c engineeringCrossRunLearn=%s at synth', (value) => {
    expect(() => runtimeStack({ engineeringAgents: 'true', engineeringCrossRunLearn: value }))
      .toThrow(/engineeringCrossRunLearn is weekly or off/);
  }, SYNTH_TIMEOUT_MS);

  it('keys the records, the rows and the action as the runtime does (learning/cross_run.py, runtime/handler.py)', () => {
    const pass = fs.readFileSync(path.join(LAMBDA, 'learning/cross_run.py'), 'utf8');
    const handler = fs.readFileSync(path.join(LAMBDA, 'runtime/handler.py'), 'utf8');
    expect([pass.includes("return f'ws/{WORKSPACE}/learn/{check_flow(flow)}/"),
      pass.includes("return f'WS#{WORKSPACE}#LEARN#{check_flow(flow)}'")]).toStrictEqual([true, true]);
    expect(handler).toContain("'learn_cross_run': learn_cross_run,");
  });
});
