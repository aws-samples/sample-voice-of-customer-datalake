/**
 * What every AgentCore Runtime execution role has (the engineering agents' and the voice personas' relay):
 * - the trust policy the AgentCore guide asks for: `bedrock-agentcore.amazonaws.com`, only for this account's AgentCore
 *   resources in this stack's region (confused-deputy protection);
 * - its runtimes' own logs, which the service names `/aws/bedrock-agentcore/runtimes/<runtime id>-<endpoint>`.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

export function agentCoreTrust(stack: cdk.Stack): iam.PrincipalBase {
  return new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com').withConditions({
    StringEquals: { 'aws:SourceAccount': stack.account },
    ArnLike: { 'aws:SourceArn': stack.formatArn({ service: 'bedrock-agentcore', resource: '*' }) },
  });
}

/**
 * `RuntimeLogs`: create and write the log groups and streams of the runtimes `runtimes` names (`*`, or a runtime's
 * name and `-*` for its generated id); the two ARNs, for the role's IAM5 acknowledgement.
 */
export function grantRuntimeLogs(role: iam.Role, runtimes: string): string[] {
  const logs = cdk.Stack.of(role).formatArn({
    service: 'logs', resource: 'log-group', resourceName: `/aws/bedrock-agentcore/runtimes/${runtimes}`,
    arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
  });
  const resources = [logs, `${logs}:log-stream:*`];
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'RuntimeLogs', actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], resources,
  }));
  return resources;
}
