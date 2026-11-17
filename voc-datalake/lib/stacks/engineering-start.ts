/**
 * voc-engineering-start (engineering-runtime.ts, with `-c engineeringAgents=true`): the name the Agents API invokes for
 * `POST /agents/engineering/runs` (api-assistant-lambdas.ts, ENGINEERING_START_FUNCTION). The runtime's code, with a
 * role of its own holding only what a start needs (`startRole`), entered at `start_handler`, which takes `start_run`,
 * `restart_run` (7.51.00: a person's Resume or Restart of an ended run, as a child run, its seeds handed on to the
 * runtime's `seed_restart`) and `ask_reactions`, and refuses every other action before anything is read; it writes
 * the run and hands the coordinator's launch on to voc-engineering-runtime (`launch_coordinator`). The API's
 * role may invoke this function and never voc-engineering-runtime, so it can start a run and never tick, launch,
 * signal an agent or end a run otherwise. Since 7.50.03 it also takes `stop_run`, the run monitor's Stop of a whole
 * run (lambda/engineering/runtime/stop.py): it ends the run (its META, its tasks, its launch holds) or records the
 * request, and hands the rest on to voc-engineering-runtime (`end_run`, `stop_run`), so a Stop never needs the
 * runtime's own function or the bus. Since 7.47.00 the agents' heartbeat invokes it too, by name (agent-heartbeat-engineering.ts: an
 * engineering agent's trigger), and a start that resolves its commit calls the broker's `head` (its function URL, which
 * admits this role for that operation alone). Pay per use: no fixed cost.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

import { ENGINEERING_START_FUNCTION_BASE_NAME } from '../utils/function-names';
import { createWorkerFunction, grantInvokeByName, workerRole } from '../utils/worker-lambda';
import { ENGINEERING_RUNLIST_PARTITIONS, ENGINEERING_SPEND_PARTITIONS } from './core-buckets';
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
  /** The connector broker, whose function URL a start that resolves its commit calls for its `head` (7.47.00). */
  broker: lambda.IFunction;
  /** The broker's admission of this function's role for `head` alone (EngineeringBroker.admitStart). */
  admitStart: (role: iam.IRole, functionName: string) => void;
}

/**
 * What a start writes (lambda/engineering/runtime/runs.py RunStore.start, needs_human): its run's partition, the registry
 * and (7.51.00) its month's runs list.
 */
const START_PARTITIONS = ['WS#*#RUN#*', 'WS#*#RUNS', ENGINEERING_RUNLIST_PARTITIONS];
/**
 * The runs' partitions alone, never the registry: a Stop reads its run's tasks and agents there (7.50.03:
 * runtime/stop.py), a restart its parent's flow plan (its tasks and step rows, 7.51.00).
 */
const RUN_PARTITIONS = 'WS#*#RUN#*';

/**
 * voc-engineering-start's own role (TENETS.md tenet 6: a role per Lambda), with only what `start_run` without its launch
 * (and `restart_run`, 7.51.00: a child run, its parent's partition read) uses: the run's rows, its registry row and its
 * runs list row (GetItem, PutItem, UpdateItem: the start's transaction, a decision point),
 * a flow's month total and the hard cap's row (GetItem, at a budgeted start), the stack's key through DynamoDB, its
 * rule switched on (never off), and the runtime invoked by name for the launch. Since 7.50.03 a Stop: Query of the run's
 * own partition (its tasks and agent rows, `StopRunReads`), its writes those of the run's rows above. No agent session,
 * no AssumeRole of an agent role, no bus, no delete, no registry query: the supervisor's role keeps those.
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
  // A Resume or Restart of an ended run (7.51.00, restart_run): its parent's partition read (the flow's plan: its tasks
  // and step rows), so the child inherits the steps the parent had done. Reads only, the runs' partitions only.
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'RestartReadsTheParent', actions: ['dynamodb:Query'], resources: [props.engineeringTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [RUN_PARTITIONS] } },
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'StopRunReads', actions: ['dynamodb:Query'], resources: [props.engineeringTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [RUN_PARTITIONS] } },
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
  // An engineering agent's start resolves its commit (7.47.00): the broker's `head`, through its function URL with IAM
  // auth only, as the agents and the runtime call it; the broker admits this role for that operation alone.
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'StartBrokerHead', actions: ['lambda:InvokeFunctionUrl'], resources: [props.broker.functionArn],
    conditions: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'StartBrokerHeadThroughUrl', actions: ['lambda:InvokeFunction'], resources: [props.broker.functionArn],
    conditions: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
  }));
  return role;
}

export function createEngineeringStart(scope: Construct, props: StartProps): lambda.Function {
  const functionName = props.uniqueName(ENGINEERING_START_FUNCTION_BASE_NAME);
  const role = startRole(scope, props);
  props.admitStart(role, functionName);
  return createWorkerFunction(scope, 'EngineeringStart', {
    tree: 'engineering',
    functionName,
    handler: 'engineering/runtime/handler.start_handler',
    role,
    layer: props.layer,
    // A start only writes the run and switches the rule on, then hands the coordinator's launch on to
    // voc-engineering-runtime (`launch_coordinator`, asynchronously: its 5 minutes cover a session's start, which API
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
