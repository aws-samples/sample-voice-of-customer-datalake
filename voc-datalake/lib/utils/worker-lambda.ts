/**
 * Shared shape of the memory and autonomous-agent worker Lambdas
 * (VocProcessingStack): Python 3.15 on Graviton, the processing layer, a
 * 30-day log group, its own least-privilege role.
 *
 * The bundle keeps the worker tree's directory structure and puts `shared/`
 * beside it, so the handler string is path-style (`memory/extractor/handler.lambda_handler`
 * — the Python runtime turns `/` into `.` before importing) and sibling modules
 * of a worker (`memory/<x>.py`, `agents/<x>.py`) ship with it. `api/prompts`
 * lands at the bundle root like every other bundle (shared/prompts.py looks
 * there first).
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { LOG_RETENTION } from './log-retention';
import { Construct } from 'constructs';

import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from './lambda-asset-excludes';
import { pythonLambdaAsset } from './python-lambda-asset';
import { grantKeyScopedWrites } from './table-write-grants';

/** The worker trees under `lambda/`. */
type WorkerTree = 'memory' | 'agents' | 'briefing' | 'engineering';

const WORKER_TREES: readonly WorkerTree[] = ['memory', 'agents', 'briefing', 'engineering'];

/** Asset excludes for every worker tree except `tree`. */
function otherTrees(tree: WorkerTree): string[] {
  return WORKER_TREES.filter((other) => other !== tree).map((other) => `/${other}/`);
}

/**
 * The asset for one worker tree. Staged from `lambda/` and pruned to the tree,
 * `shared/` and `api/prompts`, so an edit anywhere else (including the other
 * worker tree) never changes this hash.
 */
function workerLambdaCode(tree: WorkerTree): lambda.Code {
  return pythonLambdaAsset('lambda', {
    exclude: [
      ...PY_LAMBDA_ASSET_EXCLUDES,
      ...otherTrees(tree),
      '/aggregator/',
      '/api/*',
      '!/api/prompts',
      '/jobs/',
      '/processor/',
      '/research/',
    ],
    copy: [
      'mkdir -p /asset-output',
      `cp -r /asset-input/${tree} /asset-output/`,
      'cp -r /asset-input/shared /asset-output/',
      'cp -r /asset-input/api/prompts /asset-output/prompts',
    ],
  });
}

/** A Lambda role with no grant yet: its log writes come from lib/utils/lambda-log-grants.ts (its own group only). */
export function workerRole(scope: Construct, id: string): iam.Role {
  return new iam.Role(scope, id, {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  });
}

export interface WorkerFunctionSpec {
  tree: WorkerTree;
  /** Resolved physical name (already passed through the stack's `uniqueName`). */
  functionName: string;
  /** Path-style handler inside the tree, e.g. `memory/scanner/handler.lambda_handler`. */
  handler: string;
  role: iam.IRole;
  layer: lambda.ILayerVersion;
  timeout: cdk.Duration;
  memorySize: number;
  environment: Record<string, string>;
  /** Powertools service name — the function's base name. */
  serviceName: string;
  /**
   * Async re-drives. Defaults to 0: every worker is either queue/schedule
   * driven (the source retries) or a Step Functions task (the state machine
   * retries, visibly) — a hidden Lambda re-drive would double-pay model calls.
   */
  retryAttempts?: number;
  /** Where an async invocation that failed every attempt goes (a dead-letter queue); none by default. */
  onFailure?: lambda.IDestination;
}

/**
 * One asset per (stack, tree): every function of a tree shares it, so the
 * tree is staged and fingerprinted once per synth rather than once per function.
 * An AssetCode may only bind to one stack, hence the per-stack key.
 */
const codeByStack = new WeakMap<cdk.Stack, Map<WorkerTree, lambda.Code>>();

function sharedWorkerCode(scope: Construct, tree: WorkerTree): lambda.Code {
  const stack = cdk.Stack.of(scope);
  const byTree = codeByStack.get(stack) ?? new Map<WorkerTree, lambda.Code>();
  codeByStack.set(stack, byTree);
  const existing = byTree.get(tree);
  if (existing) return existing;
  const created = workerLambdaCode(tree);
  byTree.set(tree, created);
  return created;
}

export function createWorkerFunction(scope: Construct, id: string, spec: WorkerFunctionSpec): lambda.Function {
  return new lambda.Function(scope, id, {
    functionName: spec.functionName,
    runtime: lambda.Runtime.PYTHON_3_15,
    architecture: lambda.Architecture.ARM_64,
    handler: spec.handler,
    code: sharedWorkerCode(scope, spec.tree),
    role: spec.role,
    timeout: spec.timeout,
    memorySize: spec.memorySize,
    retryAttempts: spec.retryAttempts ?? 0,
    onFailure: spec.onFailure,
    environment: {
      ...spec.environment,
      POWERTOOLS_SERVICE_NAME: spec.serviceName,
      LOG_LEVEL: 'INFO',
    },
    layers: [spec.layer],
    logGroup: new logs.LogGroup(scope, `${id}Logs`, {
      logGroupName: `/aws/lambda/${spec.functionName}`,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });
}

/**
 * `lambda:InvokeFunction` on functions addressed by deterministic physical name
 * (they live in a stack that deploys LATER, or the grant would be a cycle).
 * Unqualified colon-form ARNs only — no `:*` version/alias wildcard.
 */
export function grantInvokeByName(stack: cdk.Stack, role: iam.IRole, functionNames: string[], sid?: string): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid,
    actions: ['lambda:InvokeFunction'],
    resources: functionNames.map((name) => stack.formatArn({
      service: 'lambda', resource: 'function', resourceName: name, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    })),
  }));
}

/**
 * Run `fn` on an EventBridge schedule. Two retries on an async delivery
 * failure; a run the schedule misses is picked up by the next tick, which is
 * why every scheduled worker here is written to catch up rather than to count
 * on each tick.
 */
export function scheduleWorker(
  scope: Construct,
  id: string,
  fn: lambda.IFunction,
  ruleName: string,
  schedule: events.Schedule,
  /** Event the target receives instead of the EventBridge schedule event. */
  input?: events.RuleTargetInput,
): void {
  new events.Rule(scope, id, {
    ruleName,
    schedule,
    targets: [new targets.LambdaFunction(fn, { retryAttempts: 2, event: input })],
  });
}

/** Only `jobs/<job>`, `jobs/__init__.py` and `shared/` reach a job's bundle (and its hash). */
function jobLambdaCode(job: string): lambda.Code {
  return pythonLambdaAsset('lambda', {
    exclude: [
      '/jobs/*', '!/jobs/__init__.py', `!/jobs/${job}/`,
      '/aggregator/', '/api/', '/processor/', '/research/',
      ...WORKER_TREE_ASSET_EXCLUDES, ...PY_LAMBDA_ASSET_EXCLUDES,
    ],
    copy: [
      'mkdir -p /asset-output/jobs',
      'cp /asset-input/jobs/__init__.py /asset-output/jobs/',
      `cp -r /asset-input/jobs/${job} /asset-output/jobs/`,
      'cp -r /asset-input/shared /asset-output/',
    ],
  });
}

/** What every daily job is given: the stack's naming, its layer, the key and voc-aggregates (its one write). */
export interface DailyJobProps {
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  aggregatesTable: dynamodb.ITable;
}

export interface DailyJobSpec {
  /** The job's directory under `lambda/jobs/` (its handler is `jobs/<job>/handler.lambda_handler`). */
  job: string;
  /** The function's base name (its physical name through `uniqueName`, its Powertools service name). */
  baseName: string;
  /** The function's construct id: its role is `<fnId>Role`, its log group `<fnId>Logs`, its schedule `<fnId>Schedule`. */
  fnId: string;
  memorySize: number;
  environment: Record<string, string>;
  /** When it runs, UTC, every day (its rule `<baseName>-schedule`, the event `{mode: 'scheduled'}`). */
  daily: { hour: string; minute: string };
  /** Its whole items in voc-aggregates: PutItem held to these partitions (`dynamodb:LeadingKeys`). */
  partitions: readonly string[];
  /** The job's own reads, granted on its role before the write. */
  grant: (role: iam.Role, scope: Construct) => void;
}

/**
 * A daily job of `lambda/jobs/` (the cost rollup, the leadership view's rollup) in a construct `id` of its own: its role
 * (its reads, its PutItem on voc-aggregates' `partitions`, the key), 15 minutes at most, no async retry (a day that was
 * not written is rebuilt by the next run), its 30-day log group and its schedule.
 */
export function createDailyJob(scope: Construct, id: string, props: DailyJobProps, spec: DailyJobSpec): lambda.Function {
  const worker = new Construct(scope, id);
  const functionName = props.uniqueName(spec.baseName);
  const role = workerRole(worker, `${spec.fnId}Role`);
  spec.grant(role, worker);
  grantKeyScopedWrites(props.aggregatesTable, role, ['PutItem'], spec.partitions);
  props.kmsKey.grantEncryptDecrypt(role);
  const fn = new lambda.Function(worker, spec.fnId, {
    functionName,
    runtime: lambda.Runtime.PYTHON_3_15,
    architecture: lambda.Architecture.ARM_64,
    handler: `jobs/${spec.job}/handler.lambda_handler`,
    code: jobLambdaCode(spec.job),
    role,
    timeout: cdk.Duration.minutes(15),
    memorySize: spec.memorySize,
    retryAttempts: 0,
    environment: { ...spec.environment, POWERTOOLS_SERVICE_NAME: spec.baseName, LOG_LEVEL: 'INFO' },
    layers: [props.layer],
    logGroup: new logs.LogGroup(worker, `${spec.fnId}Logs`, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });
  scheduleWorker(worker, `${spec.fnId}Schedule`, fn, props.uniqueName(`${spec.baseName}-schedule`),
    events.Schedule.cron(spec.daily), events.RuleTargetInput.fromObject({ mode: 'scheduled' }));
  return fn;
}
