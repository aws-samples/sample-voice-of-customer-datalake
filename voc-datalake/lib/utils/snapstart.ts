/**
 * Lambda SnapStart for the API Lambdas whose cold start users wait on
 * (docs/lambda-sizing.md, "SnapStart: off by default").
 *
 * OFF BY DEFAULT. SnapStart is a fixed monthly cost (a snapshot cache charge for
 * as long as a version is active, about $20 a month for these four at their sizes), and this project
 * runs fully serverless with no fixed cost by default (../../../TENETS.md, tenet 7):
 * we make a cold start faster rather than pay to hide it. `-c snapStart=true`
 * turns it on for exactly SNAPSTART_FUNCTION_IDS; {@link snapStartEnabled} is the
 * ONE place the flag is read.
 *
 * Off (the default): no `SnapStart` property, no Version, no Alias. API Gateway
 * integrates the plain function, exactly like every other API Lambda.
 *
 * On: SnapStart applies only to PUBLISHED versions, so each function gets a
 * version and a stable `live` alias, and API Gateway must invoke the alias — an
 * unqualified invoke runs `$LATEST`, which is never snapshotted. That is two
 * resources per function (AWS::Lambda::Version + AWS::Lambda::Alias) in a stack
 * that sits near CloudFormation's 500-resource ceiling, which is why the set is a
 * short, explicit list pinned by api-stack-snapstart.test.ts together with the
 * stack's resource budget (measured with the flag on). Old versions are DESTROYED
 * on update (not CDK's default RETAIN) so a deploy never leaves a snapshot accruing
 * cache charges behind it.
 *
 * Callers that invoke these functions by unqualified name (the AI assistant,
 * the MCP adapters, the agent runtime) run `$LATEST` in both modes: unchanged
 * behaviour, unchanged IAM.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IConstruct } from 'constructs';
import { booleanContextFlag } from './context-flag';
import { performanceTierEnabled } from './performance-tier';

/** Construct ids of the functions that get SnapStart when it is on, in creation order. */
export const SNAPSTART_FUNCTION_IDS = ['IntegrationsApi', 'FeedbackFormApi', 'MemoryApi', 'McpTokensApi'] as const;

/** The alias API Gateway invokes when SnapStart is on. */
export const SNAPSTART_ALIAS_NAME = 'live';

/** `-c snapStart=true` opts in; absent or false = off. */
export const SNAPSTART_CONTEXT_KEY = 'snapStart';

const SNAPSTART_PUBLISH_WARNING = '@aws-cdk/aws-lambda:snapStartRequirePublish';

/**
 * Whether this app opted in to SnapStart: `-c snapStart=true`, or the performance tier
 * (`-c performanceTier=true`, lib/utils/performance-tier.ts) that turns on every fixed-cost
 * performance feature at once. The only read of the snapStart flag.
 */
export function snapStartEnabled(scope: IConstruct): boolean {
  // Both flags are read before they are combined, so a typo in one is refused even when the other is on.
  const own = booleanContextFlag(
    scope.node.tryGetContext(SNAPSTART_CONTEXT_KEY), SNAPSTART_CONTEXT_KEY, false,
    `Use true/false (off by default: a fixed monthly cost, TENETS.md tenet 7; opt in with -c ${SNAPSTART_CONTEXT_KEY}=true).`,
  );
  const tier = performanceTierEnabled(scope);
  return tier || own;
}

/**
 * Function props for a SnapStart-listed function: when on, snapshot published versions and
 * destroy superseded ones; when off, nothing.
 */
export function snapStartFunctionProps(scope: IConstruct): Pick<lambda.FunctionProps, 'snapStart' | 'currentVersionOptions'> {
  if (!snapStartEnabled(scope)) return {};
  return {
    snapStart: lambda.SnapStartConf.ON_PUBLISHED_VERSIONS,
    currentVersionOptions: { removalPolicy: cdk.RemovalPolicy.DESTROY },
  };
}

/**
 * What API Gateway integrates for a SnapStart-listed function: the plain function when SnapStart
 * is off, the `live` alias on its current version when it is on (`$LATEST` is never snapshotted).
 *
 * With SnapStart on, also acknowledges CDK's "SnapStart only supports published versions" warning,
 * which is exactly the condition this alias satisfies (the repo's synth must print zero warnings).
 */
export function snapStartInvokeTarget(fn: lambda.Function): lambda.IFunction {
  // The list is the budget (two resources each when on) and what the tests pin: refuse anything off it.
  if (!SNAPSTART_FUNCTION_IDS.some((id) => id === fn.node.id)) {
    throw new Error(`${fn.node.id} is not in SNAPSTART_FUNCTION_IDS (lib/utils/snapstart.ts)`);
  }
  if (!snapStartEnabled(fn)) return fn;
  cdk.Annotations.of(fn).acknowledgeWarning(
    SNAPSTART_PUBLISH_WARNING,
    'API Gateway invokes the published `live` alias (lib/utils/snapstart.ts)',
  );
  return new lambda.Alias(fn, 'LiveAlias', { aliasName: SNAPSTART_ALIAS_NAME, version: fn.currentVersion });
}
