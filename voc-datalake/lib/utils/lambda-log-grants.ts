/**
 * Every Lambda function may write ONLY to its own log group (cdk-nag AwsSolutions-IAM4).
 *
 * Through 5.76 each function role held the AWS managed `service-role/AWSLambdaBasicExecutionRole`
 * (logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents on `*`): any function could write to, and create,
 * any log group in the account. Every function now logs to a log group CloudFormation creates first (its own
 * `logGroup`, or the one lib/utils/log-retention.ts gives a function CDK created for us), so the role needs:
 *
 * - `logs:CreateLogStream` and `logs:PutLogEvents` on `arn:…:log-group:<its group>:*`. Both authorize against the
 *   `log-stream` resource type, `arn:…:log-group:<name>:log-stream:<stream>` (Service Authorization Reference,
 *   Amazon CloudWatch Logs: list_logs.html), which the trailing `:*` covers; it is the form the Lambda developer
 *   guide uses for a function's own group (monitoring-cloudwatchlogs-loggroups.html). The resource is the log
 *   group's `Arn` attribute, which CloudFormation returns WITH that `:*` (AWS::Logs::LogGroup return values).
 * - NOT `logs:CreateLogGroup`: the group exists before the function (the function's `LoggingConfig.LogGroup`
 *   references it, so CloudFormation creates the group first). A group deleted by hand is not recreated by
 *   Lambda any more; the function's logs stop until a deploy recreates it.
 *
 * X-Ray (`tracing: ACTIVE`) grants are separate statements CDK adds; nothing here touches them.
 *
 * Applied by the log-retention aspect to every function the app synthesizes, CDK's own included (provider
 * framework onEvent, AwsCustomResource and BucketDeployment singletons, the S3 bucket-notifications handler,
 * CustomResourceProvider handlers such as S3 auto-delete). The managed policy is removed from the role at the
 * same time. Not reachable: the cross-region export reader/writer providers, which CDK adds after aspects run
 * (see log-retention.ts); they keep the managed policy, and cdk-nag does not inspect their raw role.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { z } from 'zod';

/** The managed policy this module replaces, as its ARN ends. */
export const LAMBDA_BASIC_EXECUTION_POLICY = 'service-role/AWSLambdaBasicExecutionRole';

/** What a function needs to write its own logs (see the module comment for the resource form). */
const LOG_WRITE_ACTIONS: readonly string[] = ['logs:CreateLogStream', 'logs:PutLogEvents'];

/** `arn:…:logs:<region>:<account>:log-group:<name>` (`name` may end in `:*` or hold a `*` pattern). */
export function logGroupArn(stack: cdk.Stack, name: string): string {
  return stack.formatArn({ service: 'logs', resource: 'log-group', resourceName: name, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME });
}

const ManagedPolicyListSchema = z.array(z.unknown()).optional();

/**
 * Drop one AWS managed policy from an L1 role's `ManagedPolicyArns`. Set on the L1 property (not as an
 * override) because cdk-nag reads the property; the remaining ARNs are kept as they resolve.
 */
export function removeAwsManagedPolicy(role: iam.CfnRole, policyName: string): void {
  const resolved = ManagedPolicyListSchema.parse(cdk.Stack.of(role).resolve(role.managedPolicyArns));
  if (resolved === undefined) return;
  const suffix = `:iam::aws:policy/${policyName}`;
  const kept = resolved.filter((arn) => !JSON.stringify(arn).includes(suffix));
  if (kept.length === resolved.length) return;
  role.managedPolicyArns = kept.length === 0 ? undefined : kept.map((arn) => cdk.Token.asString(arn));
}

/** The construct a token string refers to (`Ref` / `Fn::GetAtt` of a resource in the app), if it is one. */
function referenceTarget(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  const token = cdk.Tokenization.reverse(value, { failConcat: false });
  return token !== undefined && cdk.Reference.isReference(token) ? token.target : undefined;
}

function isLoggingConfig(value: unknown): value is lambda.CfnFunction.LoggingConfigProperty {
  return typeof value === 'object' && value !== null && !cdk.Tokenization.isResolvable(value);
}

/**
 * The log group a function already names in `LoggingConfig.LogGroup`, as the ARN its role may write to.
 * Undefined when the function names none (log-retention.ts gives it one).
 */
export function namedLogGroupArn(fn: lambda.CfnFunction): string | undefined {
  const config: unknown = fn.loggingConfig;
  if (!isLoggingConfig(config) || config.logGroup === undefined) return undefined;
  const target = referenceTarget(config.logGroup);
  if (target instanceof logs.CfnLogGroup) return target.attrArn;
  if (!cdk.Token.isUnresolved(config.logGroup)) {
    // A group named literally (an imported group): the same `Arn` form CloudFormation returns.
    return logGroupArn(cdk.Stack.of(fn), `${config.logGroup}:*`);
  }
  throw new Error(`${fn.node.path}: cannot tell which log group LoggingConfig.LogGroup names`);
}

/** How a function's role takes a statement and loses the managed policy. */
interface LogWriterRole {
  addStatement(statement: iam.PolicyStatement): void;
  removeBasicExecutionPolicy(): void;
}

function l2Role(role: iam.Role): LogWriterRole {
  const cfn = role.node.defaultChild;
  if (!(cfn instanceof iam.CfnRole)) throw new Error(`${role.node.path}: no CfnRole`);
  return {
    addStatement: (statement) => { role.addToPrincipalPolicy(statement); },
    removeBasicExecutionPolicy: () => { removeAwsManagedPolicy(cfn, LAMBDA_BASIC_EXECUTION_POLICY); },
  };
}

/**
 * A CustomResourceProvider's raw `AWS::IAM::Role` (CDK core): its statements go in the role's inline policy, and
 * its `ManagedPolicyArns` holds exactly the basic execution policy, so the property is deleted.
 */
function providerRole(provider: cdk.CustomResourceProviderBase): LogWriterRole {
  const raw = provider.node.tryFindChild('Role');
  if (!(raw instanceof cdk.CfnResource)) throw new Error(`${provider.node.path}: no Role`);
  return {
    addStatement: (statement) => { provider.addToRolePolicy(statement.toStatementJson()); },
    removeBasicExecutionPolicy: () => { raw.addPropertyDeletionOverride('ManagedPolicyArns'); },
  };
}

function roleOf(fn: cdk.CfnResource): LogWriterRole {
  if (fn instanceof lambda.CfnFunction) {
    const target = referenceTarget(fn.role);
    if (target instanceof iam.CfnRole && target.node.scope instanceof iam.Role) return l2Role(target.node.scope);
  } else {
    // A raw function resource: a CustomResourceProvider's handler, or the S3 notifications handler (its
    // sibling `Role` is an iam.Role).
    const scope = fn.node.scope;
    if (scope instanceof cdk.CustomResourceProviderBase) return providerRole(scope);
    const sibling = scope?.node.tryFindChild('Role');
    if (sibling instanceof iam.Role) return l2Role(sibling);
  }
  throw new Error(`${fn.node.path}: cannot find the function's role to grant it its log group`);
}

/**
 * Let `fn` write to the log group `logGroupArn` (the group's `Arn` attribute, ending `:*`) and remove the
 * basic execution managed policy from its role. A role shared by several functions gets every group.
 */
export function grantOwnLogGroupWrites(fn: cdk.CfnResource, logGroupArn: string): void {
  const role = roleOf(fn);
  // No sid: a role shared by several functions then gets ONE statement listing every group
  // (`@aws-cdk/aws-iam:minimizePolicies` merges statements that differ only in resources).
  role.addStatement(new iam.PolicyStatement({ actions: [...LOG_WRITE_ACTIONS], resources: [logGroupArn] }));
  role.removeBasicExecutionPolicy();
}
