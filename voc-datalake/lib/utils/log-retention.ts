/**
 * Every Lambda function gets a managed log group with a retention period.
 *
 * Our own functions set one (`logs.RetentionDays.TWO_WEEKS`, lib/utils/worker-lambda.ts and the api-*
 * builders), but the functions CDK creates for us — custom resource providers (S3 auto-delete, cross-region
 * export reader/writer), the bucket-notifications handler, BucketDeployment's singleton — set no
 * `LoggingConfig`. Lambda then creates `/aws/lambda/<name>` itself on first invocation with NO retention,
 * so their logs never expire (found in the 5.25.03 logging audit: 7 such groups in production).
 *
 * The aspect gives every such function a stack-owned log group with our retention. Their roles already
 * hold the basic execution policy (logs:CreateLogStream / PutLogEvents on any group), so no grant is needed.
 *
 * Not reachable: the cross-region export reader/writer providers (`crossRegionReferences`), which CDK adds
 * while synthesizing, after aspects ran. They run only during a deploy; their `/aws/lambda/...` groups need
 * a one-time `aws logs put-retention-policy` (docs/deployment.md).
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { IConstruct } from 'constructs';

const RETENTION = logs.RetentionDays.TWO_WEEKS;

/**
 * A Lambda function that names no log group: an L1 `CfnFunction` without `loggingConfig`, or a
 * custom-resource provider's raw `CfnResource` of that type (CDK never gives those a LoggingConfig).
 */
function withoutLogGroup(node: IConstruct): cdk.CfnResource | undefined {
  if (node instanceof lambda.CfnFunction) return node.loggingConfig === undefined ? node : undefined;
  return cdk.CfnResource.isCfnResource(node) && node.cfnResourceType === 'AWS::Lambda::Function' ? node : undefined;
}

class LambdaLogRetentionAspect implements cdk.IAspect {
  visit(node: IConstruct): void {
    const fn = withoutLogGroup(node);
    if (fn === undefined) return;
    // Path-unique id: several CDK providers share a short id ('Resource', 'Handler') in one stack.
    const group = new logs.LogGroup(fn.stack, `${cdk.Names.uniqueId(fn)}LogGroup`, {
      retention: RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    fn.addPropertyOverride('LoggingConfig.LogGroup', group.logGroupName);
  }
}

/** Apply to the app (bin/voc-datalake.ts): every stack's functions end up with a retained log group. */
export function applyLambdaLogRetention(scope: IConstruct): void {
  cdk.Aspects.of(scope).add(new LambdaLogRetentionAspect());
}
