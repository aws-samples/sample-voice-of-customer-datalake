/**
 * Lambda SnapStart for the API Lambdas whose cold start users wait on
 * (docs/lambda-sizing.md, "Cold starts").
 *
 * SnapStart applies only to PUBLISHED versions, so a SnapStart function needs a
 * version and a stable alias, and API Gateway must invoke the alias — an
 * unqualified invoke runs `$LATEST`, which is never snapshotted. That is two
 * resources per function (AWS::Lambda::Version + AWS::Lambda::Alias) in a stack
 * that sits near CloudFormation's 500-resource ceiling, which is why the set is a
 * short, explicit list (SNAPSTART_FUNCTION_IDS) pinned by api-stack-snapstart.test.ts
 * together with the stack's resource budget.
 *
 * Callers that invoke these functions by unqualified name (the AI assistant,
 * the MCP adapters, the agent runtime) keep running `$LATEST`: unchanged
 * behaviour, unchanged IAM, just no snapshot for those calls.
 *
 * Cost: a cache charge per GB of configured memory for as long as a version is
 * active, plus a restore charge per GB per restored environment. Old versions
 * are DESTROYED on update (not CDK's default RETAIN) so a deploy never leaves
 * a snapshot accruing cache charges behind it.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/** Construct ids of the functions that get SnapStart, in creation order. */
export const SNAPSTART_FUNCTION_IDS = ['IntegrationsApi', 'FeedbackFormApi', 'MemoryApi', 'McpTokensApi'] as const;

/** The alias API Gateway invokes. */
export const SNAPSTART_ALIAS_NAME = 'live';

const SNAPSTART_PUBLISH_WARNING = '@aws-cdk/aws-lambda:snapStartRequirePublish';

/** Function props that turn SnapStart on: snapshot published versions, destroy superseded ones. */
export function snapStartFunctionProps(): Pick<lambda.FunctionProps, 'snapStart' | 'currentVersionOptions'> {
  return {
    snapStart: lambda.SnapStartConf.ON_PUBLISHED_VERSIONS,
    currentVersionOptions: { removalPolicy: cdk.RemovalPolicy.DESTROY },
  };
}

/**
 * The `live` alias on the function's current version — what API Gateway must
 * integrate with for SnapStart to apply.
 *
 * Also acknowledges CDK's "SnapStart only supports published versions" warning,
 * which is exactly the condition this alias satisfies (the repo's synth must
 * print zero warnings).
 */
export function snapStartAlias(fn: lambda.Function): lambda.Alias {
  // The list is the budget (two resources each) and what the tests pin: refuse anything off it.
  if (!SNAPSTART_FUNCTION_IDS.some((id) => id === fn.node.id)) {
    throw new Error(`${fn.node.id} is not in SNAPSTART_FUNCTION_IDS (lib/utils/snapstart.ts)`);
  }
  cdk.Annotations.of(fn).acknowledgeWarning(
    SNAPSTART_PUBLISH_WARNING,
    'API Gateway invokes the published `live` alias (lib/utils/snapstart.ts)',
  );
  return new lambda.Alias(fn, 'LiveAlias', { aliasName: SNAPSTART_ALIAS_NAME, version: fn.currentVersion });
}
