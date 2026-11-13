/**
 * voc-engineering-start (engineering-runtime.ts, with `-c engineeringAgents=true`): the name the Agents API invokes for
 * `POST /agents/engineering/runs` (api-assistant-lambdas.ts, ENGINEERING_START_FUNCTION). The runtime's code, with a
 * role of its own holding only what a start needs (`startRole`), entered at `start_handler`, which takes `start_run` and refuses every other action before anything is read; it writes
 * the run and hands the coordinator's launch on to voc-engineering-runtime (`launch_coordinator`). The API's
 * role may invoke this function and never voc-engineering-runtime, so it can start a run and never tick, launch,
 * signal or end one. Pay per use: no fixed cost.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

import { ENGINEERING_START_FUNCTION_BASE_NAME } from '../utils/function-names';
import { createWorkerFunction, grantInvokeByName, workerRole } from '../utils/worker-lambda';
import { ENGINEERING_SPEND_PARTITIONS } from './core-buckets';
import { HARD_CAP_PARTITION, viaServices } from './engineering-runtime-grants';

/** `-c engineeringRunCapUsd` and `-c engineeringRunTokenCap`: every run's cost and token caps (TENETS.md tenet 7). */
const RUN_CAPS = [
  { context: 'engineeringRunCapUsd', env: 'ENGINEERING_RUN_CAP_USD', fallback: '50', pattern: /^\d+(\.\d{1,2})?$/,
    unit: 'amount of dollars and cents' },
  { context: 'engineeringRunTokenCap', env: 'ENGINEERING_RUN_TOKEN_CAP', fallback: '10000000', pattern: /^\d+$/,
    unit: 'whole number of model tokens' },
] as const;

/**
 * The Agents API's environment for the caps every run it starts gets (agents_handler.py start_engineering_run): its
 * cost cap (default 50 USD; the hard cap, when on, lowers it to what is left of the flow's month) and its model tokens
 * (default 10 million). A value that is not a positive number fails the synth, so no deployment starts an uncapped run.
 */
export function engineeringRunCaps(scope: Construct): Record<string, string> {
  return Object.fromEntries(RUN_CAPS.map(({ context, env, fallback, pattern, unit }) => {
    const raw: unknown = scope.node.tryGetContext(context);
    const text = raw === undefined || raw === null || raw === '' ? fallback : String(raw).trim();
    if (!pattern.test(text) || Number(text) <= 0) throw new Error(`-c ${context} is a positive ${unit}.`);
    return [env, text];
  }));
}

interface StartProps {
  /** The owning stack's prefix-aware `uniqueName()`. */
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  /** voc-engineering: the runs' partitions and the registry of active runs. */
  engineeringTable: dynamodb.ITable;
  /** voc-agents: the administrators' hard cap row, read at a budgeted start. */
  agentsTable: dynamodb.ITable;
  /** The supervisor's EventBridge rule, which a start switches on. */
  ruleName: string;
  /** The supervisor's environment; the start takes all of it but the benchmark's cases (it runs no retrospective). */
  environment: Record<string, string>;
  /** voc-engineering-runtime, which launches the run's coordinator once the run is written. */
  runtime: lambda.IFunction;
}

/** What a start writes (lambda/engineering/runtime/runs.py RunStore.start, needs_human): its run's partition, the registry. */
const START_PARTITIONS = ['WS#*#RUN#*', 'WS#*#RUNS'];

/**
 * voc-engineering-start's own role (TENETS.md tenet 6: a role per Lambda), with only what `start_run` without its launch
 * uses: the run's rows and its registry row (GetItem, PutItem, UpdateItem: the start's transaction, a decision point),
 * a flow's month total and the hard cap's row (GetItem, at a budgeted start), the stack's key through DynamoDB, its
 * rule switched on (never off), and the runtime invoked by name for the launch. No MicroVM, no AssumeRole of an agent
 * role, no bus, no delete, no registry query: the supervisor's role keeps those.
 */
function startRole(scope: Construct, props: StartProps): iam.Role {
  const role = workerRole(scope, 'EngineeringStartRole');
  const stack = cdk.Stack.of(scope);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'StartRunRows',
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    resources: [props.engineeringTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': START_PARTITIONS } },
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'StartFlowMonthTotal', actions: ['dynamodb:GetItem'], resources: [props.engineeringTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [ENGINEERING_SPEND_PARTITIONS] } },
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'StartHardCapSetting', actions: ['dynamodb:GetItem'], resources: [props.agentsTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [HARD_CAP_PARTITION] } },
  }));
  role.addToPrincipalPolicy(viaServices(props.kmsKey, ['kms:Decrypt', 'kms:GenerateDataKey'], ['dynamodb']));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'SwitchTheSupervisorOn', actions: ['events:EnableRule'],
    resources: [stack.formatArn({ service: 'events', resource: 'rule', resourceName: props.ruleName })],
  }));
  grantInvokeByName(stack, role, [props.runtime.functionName], 'HandTheLaunchOn');
  return role;
}

export function createEngineeringStart(scope: Construct, props: StartProps): lambda.Function {
  return createWorkerFunction(scope, 'EngineeringStart', {
    tree: 'engineering',
    functionName: props.uniqueName(ENGINEERING_START_FUNCTION_BASE_NAME),
    handler: 'engineering/runtime/handler.start_handler',
    role: startRole(scope, props),
    layer: props.layer,
    // A start only writes the run and switches the rule on, then hands the coordinator's launch on to
    // voc-engineering-runtime (`launch_coordinator`, asynchronously: its 5 minutes cover a MicroVM's start, which API
    // Gateway's 29 s could not): the API waits 25 s for this, and answers 202 once the run is written.
    timeout: cdk.Duration.seconds(30),
    memorySize: 512,
    serviceName: 'voc-engineering-start',
    environment: {
      ...Object.fromEntries(Object.entries(props.environment).filter(([name]) => name !== 'ENGINEERING_BENCHMARK_CASES')),
      // Where the launch is handed on (its role's HandTheLaunchOn).
      ENGINEERING_RUNTIME_FUNCTION: props.runtime.functionName,
    },
    // Never retried: an asynchronous invoke (which the API's grant would allow) is not retried either.
    retryAttempts: 0,
  });
}
