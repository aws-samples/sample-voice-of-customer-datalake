/**
 * Shared shape of the memory and autonomous-agent worker Lambdas
 * (VocProcessingStack): Python 3.14 on Graviton, the processing layer, a
 * two-week log group, its own least-privilege role.
 *
 * The bundle keeps the worker tree's directory structure and puts `shared/`
 * beside it, so the handler string is path-style (`memory/extractor/handler.lambda_handler`
 * — the Python runtime turns `/` into `.` before importing) and sibling modules
 * of a worker (`memory/<x>.py`, `agents/<x>.py`) ship with it. `api/prompts`
 * lands at the bundle root like every other bundle (shared/prompts.py looks
 * there first).
 */
import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { PY_LAMBDA_ASSET_EXCLUDES } from './lambda-asset-excludes';

/** The two worker trees under `lambda/`. */
type WorkerTree = 'memory' | 'agents';

const OTHER_TREE: Record<WorkerTree, WorkerTree> = { memory: 'agents', agents: 'memory' };

/**
 * The asset for one worker tree. Staged from `lambda/` and pruned to the tree,
 * `shared/` and `api/prompts`, so an edit anywhere else (including the other
 * worker tree) never changes this hash.
 */
function workerLambdaCode(tree: WorkerTree): lambda.Code {
  return lambda.Code.fromAsset('lambda', {
    exclude: [
      ...PY_LAMBDA_ASSET_EXCLUDES,
      `/${OTHER_TREE[tree]}/`,
      '/aggregator/',
      '/api/*',
      '!/api/prompts',
      '/jobs/',
      '/processor/',
      '/research/',
    ],
    ignoreMode: cdk.IgnoreMode.GIT,
    bundling: {
      image: lambda.Runtime.PYTHON_3_14.bundlingImage,
      command: [
        'bash', '-c',
        `mkdir -p /asset-output && cp -r /asset-input/${tree} /asset-output/ && ` +
        'cp -r /asset-input/shared /asset-output/ && ' +
        'cp -r /asset-input/api/prompts /asset-output/prompts',
      ],
      platform: 'linux/arm64',
    },
  });
}

/** A Lambda role with only the basic execution (logs) managed policy. */
export function workerRole(scope: Construct, id: string): iam.Role {
  return new iam.Role(scope, id, {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
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
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: spec.handler,
    code: sharedWorkerCode(scope, spec.tree),
    role: spec.role,
    timeout: spec.timeout,
    memorySize: spec.memorySize,
    retryAttempts: spec.retryAttempts ?? 0,
    environment: {
      ...spec.environment,
      POWERTOOLS_SERVICE_NAME: spec.serviceName,
      LOG_LEVEL: 'INFO',
    },
    layers: [spec.layer],
    logGroup: new logs.LogGroup(scope, `${id}Logs`, {
      logGroupName: `/aws/lambda/${spec.functionName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
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
