/**
 * People's reactions on the host (engineering-reactions.ts, 7.10.00): off by default; with the module on, one schedule
 * group, the scheduler's own role (invoke the runtime, nothing else), and on the runtime's role exactly the schedule's
 * create, the pass of that role to EventBridge Scheduler and the broker's function URL; the broker admits the runtime.
 */
import * as fs from 'fs';
import * as path from 'path';

import { Match, type Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type Admitted, count, policyText, runtimeStack, supervisorEnv } from '../test-support/engineering-runtime-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { REACTIONS_SCHEDULE_PREFIX } from './engineering-reactions';

const StatementsSchema = z.array(z.looseObject({ Sid: z.string().optional() }));
const SCHEDULES = ':scheduler:us-east-1:111111111111:schedule/voc-engineering-reactions/voc-eng-reactions-*';
const BROKER = 'arn:aws:lambda:us-east-1:111111111111:function:voc-engineering-broker';

/** The statements of the policies on the role whose logical id contains `roleId`. */
function statements(template: Template, roleId: string): Record<string, unknown>[] {
  return Object.values(template.findResources('AWS::IAM::Policy', {
    Properties: { Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp(roleId) }]) },
  })).flatMap((policy) => StatementsSchema.parse(policy.Properties?.PolicyDocument?.Statement));
}

function sid(template: Template, name: string): Record<string, unknown> | undefined {
  return statements(template, 'EngineeringSupervisorRole').find((found) => found.Sid === name);
}

describe('people\'s reactions on the host', () => {
  it('adds no schedule group, role or grant with the module off', () => {
    const { template } = runtimeStack({});
    expect(count(template, 'AWS::Scheduler::ScheduleGroup')).toBe(0);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/scheduler|Reactions/);
  });

  describe('with -c engineeringAgents=true', () => {
    let template: Template;
    let admitted: Admitted[];
    beforeAll(() => {
      ({ template, admitted } = runtimeStack({ engineeringAgents: 'true' }));
    }, SYNTH_TIMEOUT_MS);

    it('creates one schedule group and no schedule (each run\'s is created at its end)', () => {
      expect(count(template, 'AWS::Scheduler::ScheduleGroup', { Name: 'voc-engineering-reactions' })).toBe(1);
      expect(count(template, 'AWS::Scheduler::Schedule')).toBe(0);
    });

    it('gives the scheduler a role of its own that only this account\'s group assumes and that only invokes the runtime', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: { Statement: [Match.objectLike({
          Principal: { Service: 'scheduler.amazonaws.com' },
          Condition: { StringEquals: { 'aws:SourceAccount': '111111111111' }, ArnEquals: { 'aws:SourceArn': Match.anyValue() } },
        })] },
      });
      const invoker = statements(template, 'EngineeringReactionsSchedulerRole');
      expect(invoker.map((found) => [found.Sid, found.Action])).toStrictEqual([['InvokeTheRuntime', 'lambda:InvokeFunction']]);
      expect(JSON.stringify(invoker[0]?.Resource)).toMatch(/:function:voc-engineering-runtime"\]\]\}$/);
    });

    it('lets the runtime create schedules in its group by their prefix only, and pass the scheduler\'s role to the scheduler only', () => {
      expect(sid(template, 'ReactionsSchedules')).toMatchObject({ Effect: 'Allow', Action: 'scheduler:CreateSchedule' });
      expect(JSON.stringify(sid(template, 'ReactionsSchedules')?.Resource)).toContain(SCHEDULES);
      expect(sid(template, 'ReactionsSchedulerRole')).toMatchObject({
        Action: 'iam:PassRole', Resource: { 'Fn::GetAtt': [expect.stringMatching(/EngineeringReactionsSchedulerRole/), 'Arn'] },
        Condition: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
      });
      // (no update, delete or any other scheduler action: a schedule deletes itself once it has run)
      expect(policyText(template, 'EngineeringSupervisorRole').match(/"scheduler:\w+"/g)).toStrictEqual(['"scheduler:CreateSchedule"']);
    });

    it('lets the runtime call the broker only through its IAM-authenticated function URL, as the agents do', () => {
      expect(sid(template, 'ReactionsBrokerUrl')).toMatchObject({
        Action: 'lambda:InvokeFunctionUrl', Resource: BROKER, Condition: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
      });
      expect(sid(template, 'ReactionsBrokerThroughUrl')).toMatchObject({
        Action: 'lambda:InvokeFunction', Resource: BROKER, Condition: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
      });
    });

    it('lets the runtime read whether a run keeps a pull request, in the runs\' writes\' partitions only', () => {
      expect(sid(template, 'ReactionsPullRequestReads')).toMatchObject({
        Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:Query'],
        Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#WRITES#*'] } },
      });
    });

    it('asks the broker to admit the runtime\'s own role, by its function\'s name', () => {
      expect(admitted.filter((entry) => entry.start !== true)).toStrictEqual([
        { role: { Ref: expect.stringMatching(/^EngineeringRuntimeEngineeringSupervisorRole/) }, functionName: 'voc-engineering-runtime' },
      ]);
    });

    it('writes the reactions rows with the grants it holds already: the run\'s partition and the scorecards\' PutItem', () => {
      const runRows = statements(template, 'EngineeringSupervisorRole').filter((found) => JSON.stringify(found).includes('"WS#*#RUN#*"'));
      expect(runRows.flatMap((found) => [found.Action].flat())).toContain('dynamodb:PutItem');
      expect(sid(template, 'LearningScorecards')).toMatchObject({ Action: 'dynamodb:PutItem' });
      expect(policyText(template, 'EngineeringSupervisorRole')).not.toMatch(/dynamodb:DeleteItem[^}]*WS#\*#RUN#\*/);
    });

    it('hands the runtime its group, the scheduler\'s role and the delay (3 days by default); the delivery none of them', () => {
      expect(supervisorEnv(template)).toMatchObject({
        ENGINEERING_REACTIONS_GROUP: 'voc-engineering-reactions', ENGINEERING_REACTIONS_DELAY_DAYS: '3',
        ENGINEERING_REACTIONS_ROLE_ARN: { 'Fn::GetAtt': [expect.stringMatching(/EngineeringReactionsSchedulerRole/), 'Arn'] },
      });
      const delivery = JSON.stringify(template.findResources('AWS::Lambda::Function', {
        Properties: { FunctionName: Match.stringLikeRegexp('voc-engineering-(delivery|start)') },
      }));
      expect(delivery).not.toContain('ENGINEERING_REACTIONS_');
    });
  });

  it.each([['7', '7'], [30, '30']])('takes -c engineeringReactionsDelayDays=%s', (days, expected) => {
    const { template } = runtimeStack({ engineeringAgents: 'true', engineeringReactionsDelayDays: days });
    expect(supervisorEnv(template).ENGINEERING_REACTIONS_DELAY_DAYS).toBe(expected);
  }, SYNTH_TIMEOUT_MS);

  it.each([['0'], ['31'], ['2.5'], ['three']])('refuses -c engineeringReactionsDelayDays=%s at synth', (days) => {
    expect(() => runtimeStack({ engineeringAgents: 'true', engineeringReactionsDelayDays: days }))
      .toThrow(/engineeringReactionsDelayDays is a whole number of days from 1 to 30/);
  }, SYNTH_TIMEOUT_MS);

  it('names its schedules as the runtime does (learning/reactions_read.py SCHEDULE_PREFIX)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../lambda/engineering/learning/reactions_read.py'), 'utf8');
    expect(source).toContain(`SCHEDULE_PREFIX: Final = '${REACTIONS_SCHEDULE_PREFIX}'`);
  });
});
