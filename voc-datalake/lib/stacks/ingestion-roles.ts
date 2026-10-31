/**
 * VocIngestionStack's ingestor execution roles.
 *
 * Ingestors that need only the base grants share ONE role. A plugin gets a
 * dedicated role when it needs a permission that must belong to it alone, which
 * a grant on the shared role could not express:
 *
 * - `infrastructure.ingestor.bedrock`: bedrock:InvokeModel on the curated model
 *   allowlist. It covers every model the per-surface picker can resolve to
 *   (issue #96), since these plugins invoke via shared/converse.py — kept in
 *   lockstep with lambda/shared/model_config.py through lib/utils/model-allowlist.ts.
 * - `infrastructure.ingestor.browser`: sessions of the AWS-managed AgentCore
 *   browser `aws.browser.v1` (Start/Stop on that ARN only; the automation-stream
 *   connect, which has no resource type, on `*`) — the web_reviews plugin.
 * - a schedule: events:DisableRule on the plugin's OWN schedule rule, which its
 *   circuit breaker (plugins/_shared/circuit_breaker.py) calls after repeated
 *   failures. On any other rule ARN a misbehaving plugin could switch off a
 *   sibling's ingestion, so it is never a wildcard and never on the shared role.
 *
 * Resources are created on the stack itself (logical ids `IngestionLambdaRole`
 * and `IngestorRole<Plugin>`).
 */
import type * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { NagSuppressions } from 'cdk-nag';
import { capitalize } from '../plugin-loader';
import { stackModelArns } from '../utils/model-allowlist';
import { bedrockModelSuppressions } from '../utils/nag-suppressions';
import { piiDetectionStatement } from '../utils/pii-redaction';

/** What every ingestor role is granted: watermarks, aggregates, queue, raw bucket, KMS, secrets, Comprehend PII detection. */
export interface BaseIngestionGrants {
  watermarksTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
  processingQueue: sqs.IQueue;
  rawDataBucket: s3.IBucket;
  kmsKey: kms.IKey;
  apiSecrets: secretsmanager.ISecret;
}

/** What decides whether a plugin's ingestor needs a role of its own. */
export interface IngestorRoleNeeds {
  bedrock: boolean;
  /** Sessions of the AWS-managed AgentCore browser (`infrastructure.ingestor.browser`). */
  browser?: boolean;
  /** The plugin's schedule rule name; undefined for an unscheduled plugin. */
  scheduleRuleName: string | undefined;
}

/** The AWS-managed AgentCore browser: an `aws`-owned resource, one per region. */
const MANAGED_BROWSER_ID = 'aws.browser.v1';
/** Resource-scoped AgentCore browser actions (the service authorization reference lists `browser*`). */
export const BROWSER_SESSION_ACTIONS = ['bedrock-agentcore:StartBrowserSession', 'bedrock-agentcore:StopBrowserSession'];
/**
 * The automation-stream websocket. The service authorization reference lists NO
 * resource type for it, so IAM evaluates it only against `*` (the policy
 * simulator denies it on the browser ARN). Harmless on its own: it connects only
 * to a session the same principal started with the actions above.
 */
export const BROWSER_STREAM_ACTION = 'bedrock-agentcore:ConnectBrowserAutomationStream';

/** The cdk-nag reason for the stream connect on `*`, on every browser-capable role. */
export const BROWSER_STREAM_SUPPRESSION = {
  id: 'AwsSolutions-IAM5',
  reason: 'bedrock-agentcore:ConnectBrowserAutomationStream has no resource type in the service '
    + 'authorization reference, so it can only be granted on "*"; Start/StopBrowserSession are scoped '
    + 'to the AWS-managed aws.browser.v1',
  appliesTo: ['Resource::*'],
};

/** The statements a browser-capable role is given (web_reviews ingestor, voc-design-capture). */
export function managedBrowserStatements(stack: cdk.Stack): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      actions: BROWSER_SESSION_ACTIONS,
      resources: [stack.formatArn({
        service: 'bedrock-agentcore', account: 'aws', resource: 'browser', resourceName: MANAGED_BROWSER_ID,
      })],
    }),
    new iam.PolicyStatement({ actions: [BROWSER_STREAM_ACTION], resources: ['*'] }),
  ];
}

export class IngestorRoles {
  // Created on first use, so a deployment whose ingestors all have dedicated
  // roles gets no role nothing assumes.
  private shared?: iam.Role;

  constructor(private readonly stack: cdk.Stack, private readonly grants: BaseIngestionGrants) {}

  /** The role a plugin's ingestor runs as. */
  roleFor(pluginId: string, { bedrock, browser = false, scheduleRuleName }: IngestorRoleNeeds): iam.Role {
    if (!bedrock && !browser && !scheduleRuleName) {
      this.shared ??= this.newRole('IngestionLambdaRole');
      return this.shared;
    }

    const role = this.newRole(`IngestorRole${capitalize(pluginId)}`);

    if (bedrock) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: stackModelArns(this.stack),
      }));

      // The stack-level suppressions in bin/ cover the base grants but not Bedrock,
      // so attach the Bedrock model suppression to this dedicated role explicitly.
      NagSuppressions.addResourceSuppressions(role, bedrockModelSuppressions, true);
    }

    if (browser) {
      for (const statement of managedBrowserStatements(this.stack)) role.addToPolicy(statement);
      NagSuppressions.addResourceSuppressions(role, [BROWSER_STREAM_SUPPRESSION], true);
    }

    if (scheduleRuleName) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['events:DisableRule'],
        // Built from the NAME, not from the Rule construct: the rule targets the
        // function, the function depends on this role's policy, so referencing
        // the rule's ARN attribute here would be a dependency cycle.
        resources: [this.stack.formatArn({ service: 'events', resource: 'rule', resourceName: scheduleRuleName })],
      }));
    }

    return role;
  }

  private newRole(id: string): iam.Role {
    const role = new iam.Role(this.stack, id, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const { watermarksTable, aggregatesTable, processingQueue, rawDataBucket, kmsKey, apiSecrets } = this.grants;
    watermarksTable.grantReadWriteData(role);
    aggregatesTable.grantReadWriteData(role);
    processingQueue.grantSendMessages(role);
    // Write-only under raw/ (IAM-1): ingestors only `put_object` raw/<source>/... (plugins/_shared/raw_archive.py).
    // No read and no delete: only voc-retention may delete customer data (docs/source-policies.md).
    rawDataBucket.grantPut(role, 'raw/*');
    kmsKey.grantEncryptDecrypt(role);
    apiSecrets.grantRead(role);
    role.addToPolicy(piiDetectionStatement()); // source PII policy (docs/source-policies.md)

    return role;
  }
}
