/**
 * The Agents API's readiness checks (7.50.00, `GET /agents/engineering/readiness` and Engineering Enable's 409;
 * lambda/engineering/readiness.py, readiness_aws.py), with `-c engineeringAgents=true` only: beside the reads the
 * role already has (voc-agents, the aggregates table, voc-engineering, the GitHub Apps' token function), exactly:
 *
 * - `bedrock:GetFoundationModelAvailability` (account-level: no resource ARN), each model's access;
 * - `servicequotas:GetServiceQuota` on AgentCore's one active sessions quota (`bedrock-agentcore/L-3E5722B2`);
 * - `dynamodb:GetItem` of voc-watermarks' `github_issues#repo#*` keys only: whether the deployment-wide GitHub Issues
 *   source has read a repository (its key through DynamoDB is the role's `AgentsTablesKey`);
 * - `s3:PutObject` on the workspace bucket's `ws/default/_readiness/*` only, with `kms:GenerateDataKey` through S3: the
 *   create-only probe (one object, ever: the bucket refuses any put without If-None-Match, which the probe checks);
 * - 7.53.00, only where a role runs on Kiro (`-c engineeringHarness`): `ssm:DescribeParameters`, which takes no resource,
 *   for the `kiro` check's one call, filtered to the Kiro key's exact name: its type and metadata, never its value (no
 *   `ssm:GetParameter`, no KMS grant).
 *
 * No write anywhere else, no delete, no read of a run's objects. Returns the checks' environment (7.58.00: with the
 * models' prices, `ENGINEERING_MODEL_PRICES`, which a model choice is checked against: no grant).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { bedrockAgreementSuppressions } from '../utils/nag-suppressions';
import type { ApiStackContext } from './api-context';
import { ENGINEERING_WORKSPACE_READINESS_KEYS } from './core-buckets';
import {
  agentNetworkConfigured, buildMemoryMiB, maxSessions, modelPrices, runtimeLanguages,
} from './engineering-agentcore';
import { engineeringParameterPrefix } from './engineering-broker';
import { engineeringHarness, kiroKeyParameterName } from './engineering-kiro';
import { AGENT_ROLES } from './engineering-runtime';

/** AgentCore Runtime's "Active Session Workloads per Account" (lambda/engineering/readiness_aws.py). */
export const AGENTCORE_SESSIONS_QUOTA = 'bedrock-agentcore/L-3E5722B2';
/** The deployment-wide GitHub Issues source's watermarks of its repositories (plugins/github_issues). */
export const ISSUES_WATERMARK_KEYS = 'github_issues#repo#*';

export function grantEngineeringReadiness(ctx: ApiStackContext, role: iam.Role): Record<string, string> {
  const stack = cdk.Stack.of(role);
  const bucket = ctx.props.engineeringWorkspaceBucket;
  if (!bucket) throw new Error('engineeringAgents needs VocCoreStack\'s voc-eng-workspace bucket');
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'EngineeringReadinessModels', actions: ['bedrock:GetFoundationModelAvailability'], resources: ['*'],
  }));
  acknowledgeNag(role, bedrockAgreementSuppressions);
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'EngineeringReadinessQuota', actions: ['servicequotas:GetServiceQuota'],
    resources: [stack.formatArn({ service: 'servicequotas', resource: AGENTCORE_SESSIONS_QUOTA })],
  }));
  const watermarks = ctx.uniqueName('voc-watermarks');
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'EngineeringReadinessIssuesSource', actions: ['dynamodb:GetItem'],
    resources: [stack.formatArn({ service: 'dynamodb', resource: 'table', resourceName: watermarks })],
    conditions: {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [ISSUES_WATERMARK_KEYS] },
      Null: { 'dynamodb:LeadingKeys': 'false' },
    },
  }));
  const probe = bucket.arnForObjects(ENGINEERING_WORKSPACE_READINESS_KEYS);
  role.addToPolicy(new iam.PolicyStatement({ sid: 'EngineeringReadinessProbe', actions: ['s3:PutObject'], resources: [probe] }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'EngineeringReadinessProbeKey', actions: ['kms:GenerateDataKey'], resources: [ctx.props.kmsKey.keyArn],
    conditions: { StringEquals: { 'kms:ViaService': `s3.${stack.region}.amazonaws.com` } },
  }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'The readiness probe\'s one create-only object (ws/default/_readiness/*, beside the runs\' keys): put only, never a read or a delete',
    findings: [resourceFinding(probe)],
  }]);
  const harness = engineeringHarness(stack, AGENT_ROLES);
  if (harness.kiroRoles.length > 0) {
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'EngineeringReadinessKiroKey', actions: ['ssm:DescribeParameters'], resources: ['*'],
    }));
    acknowledgeNag(role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'ssm:DescribeParameters takes no resource ARN: the kiro check\'s one call filters it to the Kiro key\'s exact '
        + 'name and reads its type only, never a value (no GetParameter, no decrypt)',
      findings: ['Resource::*'],
    }]);
  }
  return {
    ENGINEERING_HARNESS: harness.value,
    ...(harness.kiroRoles.length > 0
      ? { ENGINEERING_KIRO_KEY_PARAMETER: kiroKeyParameterName(engineeringParameterPrefix(ctx.deploymentPrefix)) } : {}),
    ENGINEERING_IMAGE_LANGUAGES: runtimeLanguages(stack).join(','),
    ENGINEERING_AGENT_NETWORK: agentNetworkConfigured(stack) ? 'vpc' : 'none',
    ENGINEERING_BUILD_MEMORY_MIB: String(buildMemoryMiB(stack)),
    ENGINEERING_MAX_SESSIONS: String(maxSessions(stack)),
    ENGINEERING_WATERMARKS_TABLE: watermarks,
    // 7.58.00: the models' prices (-c engineeringModelPrices, as the runtime has them), so a role's or a run's model
    // choice is refused when it is saved unless the deployment grants and prices it (engineering/model_choices.py).
    ENGINEERING_MODEL_PRICES: JSON.stringify(modelPrices(stack)),
  };
}
