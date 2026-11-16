/**
 * The agents' heartbeat and the engineering agents (7.47.00; docs/autonomous-agents.md "Engineering agents"), only with
 * `-c engineeringAgents=true`: an engineering agent's trigger starts its run through voc-engineering-start, as the
 * Agents API's Run now does (lambda/agents/heartbeat/engineering.py, shared/engineering_agent_runs.py).
 *
 * The heartbeat's role gains, and nothing else:
 * - `lambda:InvokeFunction` on voc-engineering-start by name (the same stack makes it later: a reference would be a
 *   cycle), never voc-engineering-runtime: the start writes the run and hands its coordinator's launch on;
 * - `dynamodb:GetItem` on voc-engineering's runs' partitions only (`WS#*#RUN#*`): a run's `META`, its status, which
 *   ends the agent's run and frees its lock; no write, no Query;
 * - `cognito-idp:AdminGetUser` and `cognito-idp:AdminListGroupsForUser` on the user pool: the administrator an agent
 *   runs as is re-checked before each start (still enabled, the same person, still in `admins`).
 * Its reads of the connections' rows, its `ISSUE_RUN#` claims and (7.50.00) the issues' trusted `ISSUE_TRIAGE#` rows
 * are voc-agents rows its existing grant covers (the connections' partitions stay write-denied, denyHardCapWrites, and
 * the triage rows too, denyIssueTriageWrites in agent-runtime.ts: voc-engineering-runtime is their one writer). No
 * fixed cost.
 */
import * as cdk from 'aws-cdk-lib';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

import { ENGINEERING_START_FUNCTION_BASE_NAME } from '../utils/function-names';
import { grantInvokeByName } from '../utils/worker-lambda';
import { engineeringAgentsEnabled } from './engineering-broker';
import { engineeringRunCaps } from './engineering-start';

/** The runs' partitions in voc-engineering (lambda/engineering/runtime/runs.py run_pk). */
const RUN_PARTITIONS = 'WS#*#RUN#*';

export interface HeartbeatEngineeringProps {
  uniqueName: (baseName: string) => string;
  /** voc-engineering (VocCoreStack, made only with the flag). */
  engineeringTable: dynamodb.ITable | undefined;
  userPool: cognito.IUserPool;
}

/** The heartbeat's grants and environment for the engineering agents; `{}` (and no grant) without the flag. */
export function grantHeartbeatEngineering(
  scope: Construct, role: iam.IRole, props: HeartbeatEngineeringProps,
): Record<string, string> {
  if (!engineeringAgentsEnabled(scope)) return {};
  if (!props.engineeringTable) throw new Error('engineeringAgents needs VocCoreStack\'s voc-engineering table');
  const start = props.uniqueName(ENGINEERING_START_FUNCTION_BASE_NAME);
  grantInvokeByName(cdk.Stack.of(scope), role, [start], 'StartEngineeringRuns');
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'EngineeringRunStatus', actions: ['dynamodb:GetItem'], resources: [props.engineeringTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [RUN_PARTITIONS] } },
  }));
  props.userPool.grant(role, 'cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser');
  return {
    ENGINEERING_AGENTS: 'on',
    ENGINEERING_TABLE: props.engineeringTable.tableName,
    ENGINEERING_START_FUNCTION: start,
    USER_POOL_ID: props.userPool.userPoolId,
    ...engineeringRunCaps(scope),
  };
}
