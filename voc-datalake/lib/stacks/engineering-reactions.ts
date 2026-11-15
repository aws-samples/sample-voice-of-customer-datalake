/**
 * People's reactions on the host to an ended run's pull request (7.10.00; docs/autonomous-engineering.md, "Getting
 * better": people's reactions), in the engineering runtime (only with `-c engineeringAgents=true`):
 *
 *   a run's retrospective ──▶ scheduler:CreateSchedule (only with a recorded pull request; one per run, at end + N
 *                             days, deleting itself after it runs)
 *   EventBridge Scheduler ──(its own role: invoke the runtime, nothing else)──▶ voc-engineering-runtime {reactions}
 *   voc-engineering-runtime {reactions} ──▶ broker `reactions` (function URL, SigV4 as the runtime's role) ──▶ rows
 *
 * The grants, on the runtime's role (lambda/engineering/runtime/handler.py, learning/reactions_read.py):
 * - the broker's function URL, as the agents call it (`lambda:InvokeFunctionUrl` with AWS_IAM auth, and
 *   `lambda:InvokeFunction` only through a function URL); the broker admits the runtime's role, in the session Lambda
 *   names after the runtime's function, for its `reactions` operation alone (connectors/identity.py
 *   runtime_caller_from_event): its env names that role and function (`admitRuntime`), and nothing else opens it;
 * - `scheduler:CreateSchedule` on this deployment's one schedule group, names `voc-eng-reactions-*` only (no update,
 *   no delete: a schedule deletes itself once it has run, `ActionAfterCompletion` DELETE);
 * - `iam:PassRole` on the scheduler's role only, only to EventBridge Scheduler: that role may only invoke the runtime;
 * - `dynamodb:GetItem` and `dynamodb:Query` of the runs' writes' partitions (`WS#*#WRITES#*`), read only: whether a
 *   run's record keeps a pull request, before its schedule is made;
 * - the reactions rows: none new (the run's partition's PutItem and the scorecards' PutItem it already holds).
 * A schedule group and schedules have no fixed cost (tenet 7): a schedule is charged when it runs, once per run.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import type { Construct } from 'constructs';

import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';

/** The CDK context key of the schedule's delay in days (default 3; lambda/engineering/learning/reactions_read.py). */
const REACTIONS_DELAY_CONTEXT_KEY = 'engineeringReactionsDelayDays';
/** Every reactions schedule's name starts so (reactions_read.py SCHEDULE_PREFIX: held equal by a test). */
export const REACTIONS_SCHEDULE_PREFIX = 'voc-eng-reactions-';
const DEFAULT_DELAY_DAYS = 3;
const MAX_DELAY_DAYS = 30;

/** `-c engineeringReactionsDelayDays`: a whole number of days from 1 to 30 (default 3); anything else fails the synth. */
function reactionsDelayDays(scope: Construct): number {
  const raw: unknown = scope.node.tryGetContext(REACTIONS_DELAY_CONTEXT_KEY);
  if (raw === undefined || raw === null || raw === '') return DEFAULT_DELAY_DAYS;
  const text = String(raw).trim();
  const days = Number(text);
  if (!/^\d+$/.test(text) || days < 1 || days > MAX_DELAY_DAYS) {
    throw new Error(`-c ${REACTIONS_DELAY_CONTEXT_KEY} is a whole number of days from 1 to ${MAX_DELAY_DAYS}.`);
  }
  return days;
}

export interface ReactionsProps {
  uniqueName: (baseName: string) => string;
  /** voc-engineering-runtime's role and its function's name (a reference to the function would be a cycle). */
  runtimeRole: iam.Role;
  runtimeFunctionName: string;
  /** The connector broker, whose function URL the runtime calls. */
  broker: lambda.IFunction;
  /** voc-engineering: the runs' recorded pull requests, read to decide on a schedule. */
  engineeringTable: dynamodb.ITable;
  /** The broker's admission of the runtime (engineering-broker.ts EngineeringBroker.admitRuntime). */
  admitRuntime: (role: iam.IRole, functionName: string) => void;
}

/** The scheduler's own role: assumed by EventBridge Scheduler for this account's schedule group only; it may invoke
 *  the runtime and nothing else. */
function schedulerRole(scope: Construct, groupArn: string, runtimeArn: string): iam.Role {
  const { account } = cdk.Stack.of(scope);
  const role = new iam.Role(scope, 'EngineeringReactionsSchedulerRole', {
    assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
      conditions: { StringEquals: { 'aws:SourceAccount': account }, ArnEquals: { 'aws:SourceArn': groupArn } },
    }),
  });
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'InvokeTheRuntime', actions: ['lambda:InvokeFunction'], resources: [runtimeArn],
  }));
  return role;
}

/** The runtime's call of the broker's function URL, as the agents' (engineering-runtime.ts createAgentRole). */
function grantBrokerUrl(role: iam.Role, broker: lambda.IFunction): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'ReactionsBrokerUrl', actions: ['lambda:InvokeFunctionUrl'], resources: [broker.functionArn],
    conditions: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'ReactionsBrokerThroughUrl', actions: ['lambda:InvokeFunction'], resources: [broker.functionArn],
    conditions: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
  }));
}

/** The reactions' resources and grants (see the module's doc); the runtime's environment for them. */
export function grantReactions(scope: Construct, props: ReactionsProps): Record<string, string> {
  const stack = cdk.Stack.of(scope);
  const groupName = props.uniqueName('voc-engineering-reactions');
  new scheduler.CfnScheduleGroup(scope, 'EngineeringReactionsGroup', { name: groupName });
  const groupArn = stack.formatArn({
    service: 'scheduler', resource: 'schedule-group', resourceName: groupName, arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
  const runtimeArn = stack.formatArn({
    service: 'lambda', resource: 'function', resourceName: props.runtimeFunctionName,
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
  const invoker = schedulerRole(scope, groupArn, runtimeArn);
  const role = props.runtimeRole;
  const schedules = stack.formatArn({
    service: 'scheduler', resource: 'schedule', resourceName: `${groupName}/${REACTIONS_SCHEDULE_PREFIX}*`,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'ReactionsSchedules', actions: ['scheduler:CreateSchedule'], resources: [schedules],
  }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'One one-time schedule per run (its id known only at run time), in this deployment\'s one schedule group '
      + 'and named voc-eng-reactions-<run>: create only, never an update or a delete (each deletes itself once run)',
    findings: [resourceFinding(schedules)],
  }]);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'ReactionsSchedulerRole', actions: ['iam:PassRole'], resources: [invoker.roleArn],
    conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
  }));
  grantBrokerUrl(role, props.broker);
  // Whether an ended run's record keeps a pull request (run_links.py run_pull_request: its row by key and one bounded
  // Query of its author's write claims), so the schedule is made only then: read only, in the runs' writes' partitions.
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'ReactionsPullRequestReads', actions: ['dynamodb:GetItem', 'dynamodb:Query'],
    resources: [props.engineeringTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#WRITES#*'] } },
  }));
  props.admitRuntime(role, props.runtimeFunctionName);
  return {
    ENGINEERING_REACTIONS_GROUP: groupName,
    ENGINEERING_REACTIONS_ROLE_ARN: invoker.roleArn,
    ENGINEERING_REACTIONS_DELAY_DAYS: String(reactionsDelayDays(scope)),
  };
}
