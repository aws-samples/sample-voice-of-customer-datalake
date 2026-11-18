/**
 * The trust policy the AgentCore guide asks for on an execution role: `bedrock-agentcore.amazonaws.com`,
 * only for this account's AgentCore resources in this stack's region (confused-deputy protection).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

export function agentCoreTrust(stack: cdk.Stack): iam.PrincipalBase {
  return new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com').withConditions({
    StringEquals: { 'aws:SourceAccount': stack.account },
    ArnLike: { 'aws:SourceArn': stack.formatArn({ service: 'bedrock-agentcore', resource: '*' }) },
  });
}
