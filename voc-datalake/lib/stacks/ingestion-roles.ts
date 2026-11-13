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
 *   failures of a deployment-wide run. On any other rule ARN a misbehaving plugin
 *   could switch off a sibling's ingestion, so it is never a wildcard and never on
 *   the shared role. And the scheduled tick's fan-out (plugins/_shared/base_ingestor.py
 *   `fan_out_tick`, docs/multi-workspace.md): dynamodb:Query on voc-workspaces for
 *   the plugin's own `PLUGIN#<id>` partition only (`dynamodb:LeadingKeys`), PutItem
 *   on voc-idempotency for its own `ingestor#fanout#<id>#*` tick claims only, and
 *   lambda:InvokeFunction on the plugin's OWN function (one async invoke per
 *   workspace; the app-review continuation parts use it too).
 *
 * Every role has both runs' grants (docs/multi-workspace.md): a deployment-wide run
 * (an event that names no workspace) reads the shared API-credentials secret and
 * writes the raw bucket under `raw/*`, as before; a run in a workspace reads that
 * workspace's credentials parameter of ITS OWN plugin only (decision 19: `ssm:GetParameter`
 * on `voc/ws/{one workspace id}/credentials/{plugin}`, and a `kms:Decrypt` through SSM for
 * those names that is no second layer, since the role holds the key's grantEncryptDecrypt
 * below; lib/utils/workspace-secrets.ts; the shared role gets each of its plugins'
 * names, so between those plugins only the code-built name separates them), the names
 * built from the event's verified workspace; its config list is a `WS#{ws}#PLUGIN_CONFIG`
 * row of voc-aggregates, which every role already reads; and writes under
 * `ws/{one workspace id}/raw/*`. The deployment-wide grants go when
 * phase 2's last slice removes that path.
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
import { acknowledgeNag, type NagAck } from '../utils/nag-ack';
import { capitalize } from '../plugin-loader';
import { grantClaudeModels } from '../utils/claude-model-grant';
import { piiDetectionStatement } from '../utils/pii-redaction';
import { grantKeyScopedWrites, grantReadAndWrites } from '../utils/table-write-grants';
import { grantInvokeByName } from '../utils/worker-lambda';
import { grantWorkspaceParameterRead } from '../utils/workspace-secrets';
import { RAW_LAYER_PREFIX, WORKSPACE_ID_PATTERN, WORKSPACE_RAW_LAYER_PREFIX } from './core-buckets';

/**
 * The circuit breaker's own rows, which it deletes when it closes (plugins/_shared/circuit_breaker.py): the
 * deployment-wide `CIRCUIT#<plugin>` / `TRIPPED`, and one per workspace, `WS#{ws}#CIRCUIT#<plugin>`. The workspace
 * segment is exactly one id (WORKSPACE_ID_PATTERN), so `WS#{ws}#SOURCE#x#CIRCUIT#y` is out of reach; a `CIRCUIT#`
 * partition is the breaker's alone. The integrations API clears the same rows (lib/stacks/api-data-lambdas.ts).
 */
export const CIRCUIT_ROW_PARTITIONS =['CIRCUIT#*', `WS#${WORKSPACE_ID_PATTERN}#CIRCUIT#*`];
/** The scheduled tick's claim keys in voc-idempotency: `ingestor#fanout#{plugin}#{event id}` (base_ingestor.py). */
const FAN_OUT_CLAIM_PREFIX = 'ingestor#fanout#';

/** What every ingestor role is granted: watermarks, aggregates, queue, raw bucket, KMS, secrets, Comprehend PII detection. */
export interface BaseIngestionGrants {
  watermarksTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
  /** voc-workspaces: the scheduled tick's list of the workspaces that enabled a plugin (scheduled roles only). */
  workspacesTable: dynamodb.ITable;
  /** voc-idempotency: the scheduled tick's claim, so it fans out at most once (scheduled roles only). */
  idempotencyTable: dynamodb.ITable;
  processingQueue: sqs.IQueue;
  rawDataBucket: s3.IBucket;
  kmsKey: kms.IKey;
  /** The deployment's shared API-credentials secret: a deployment-wide run's (an event that names no workspace). */
  apiSecrets: secretsmanager.ISecret;
  /** The workspaces' parameters' prefixed base path (`voc/ws`, `<prefix>-voc/ws`; lib/utils/workspace-secrets.ts). */
  workspaceParameterBasePath: string;
}

/** What decides whether a plugin's ingestor needs a role of its own. */
export interface IngestorRoleNeeds {
  bedrock: boolean;
  /** Sessions of the AWS-managed AgentCore browser (`infrastructure.ingestor.browser`). */
  browser?: boolean;
  /** The plugin's schedule rule name; undefined for an unscheduled plugin. */
  scheduleRuleName: string | undefined;
  /** The plugin's function name: a scheduled role may invoke this function, and only it (the tick's fan-out). */
  functionName: string;
  /** Job-end notices (`infrastructure.ingestor.jobNotices`): a dedicated role, so no other plugin may publish. */
  jobNotices?: boolean;
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
export const BROWSER_STREAM_SUPPRESSION: NagAck = {
  id: 'AwsSolutions-IAM5',
  reason: 'bedrock-agentcore:ConnectBrowserAutomationStream has no resource type in the service '
    + 'authorization reference, so it can only be granted on "*"; Start/StopBrowserSession are scoped '
    + 'to the AWS-managed aws.browser.v1',
  findings: ['Resource::*'],
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
  roleFor(
    pluginId: string, { bedrock, browser = false, scheduleRuleName, functionName, jobNotices = false }: IngestorRoleNeeds,
  ): iam.Role {
    if (!bedrock && !browser && !scheduleRuleName && !jobNotices) {
      this.shared ??= this.newRole('IngestionLambdaRole');
      this.grantOwnParameters(this.shared, pluginId);
      return this.shared;
    }

    const role = this.newRole(`IngestorRole${capitalize(pluginId)}`);
    this.grantOwnParameters(role, pluginId);

    if (bedrock) {
      grantClaudeModels(role, 'invoke');
    }

    if (browser) {
      for (const statement of managedBrowserStatements(this.stack)) role.addToPolicy(statement);
      acknowledgeNag(role, [BROWSER_STREAM_SUPPRESSION]);
    }

    if (scheduleRuleName) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['events:DisableRule'],
        // Built from the NAME, not from the Rule construct: the rule targets the
        // function, the function depends on this role's policy, so referencing
        // the rule's ARN attribute here would be a dependency cycle.
        resources: [this.stack.formatArn({ service: 'events', resource: 'rule', resourceName: scheduleRuleName })],
      }));
      this.grantFanOut(role, pluginId, functionName);
    }

    return role;
  }

  /** A run in a workspace reads `pluginId`'s one credentials parameter there (decision 19); on the shared role the
   *  other plugins' are granted too, so between those only the code-built name separates them. */
  private grantOwnParameters(role: iam.Role, pluginId: string): void {
    const { kmsKey, workspaceParameterBasePath } = this.grants;
    grantWorkspaceParameterRead(this.stack, role, workspaceParameterBasePath, kmsKey, [pluginId]);
  }

  /**
   * The scheduled tick's fan-out (base_ingestor.py `fan_out_once`): claim the tick in voc-idempotency, read the
   * workspaces that enabled the plugin and invoke this same function once per workspace.
   */
  private grantFanOut(role: iam.Role, pluginId: string, functionName: string): void {
    const { workspacesTable, idempotencyTable } = this.grants;
    // The tick's claim (base_ingestor.py `_claim_the_tick`), so a retried delivery fans out no second time: a put,
    // only of this plugin's own claim keys (the table also holds the processor's and the aggregator's records).
    grantKeyScopedWrites(idempotencyTable, role, ['PutItem'], [`${FAN_OUT_CLAIM_PREFIX}${pluginId}#*`]);
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [workspacesTable.tableArn],
      // Only this plugin's own partition, `PLUGIN#{plugin}` (lambda/shared/workspace_plugins.py): no wildcard (a
      // plugin id is `[a-z0-9_]`, so the pattern matches that one key alone).
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`PLUGIN#${pluginId}`] } },
    }));
    workspacesTable.encryptionKey?.grant(role, 'kms:Decrypt');
    // Built from the NAME: the function depends on this role's policy, so its ARN attribute here would be a cycle.
    grantInvokeByName(this.stack, role, [functionName]);
  }

  private newRole(id: string): iam.Role {
    const role = new iam.Role(this.stack, id, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    const {
      watermarksTable, aggregatesTable, processingQueue, rawDataBucket, kmsKey, apiSecrets,
    } = this.grants;
    watermarksTable.grantReadWriteData(role);
    // Run rows and counters (Put + Update, _shared/base_ingestor.py, the webscraper); the circuit breaker
    // (_shared/circuit_breaker.py) deletes only its own CIRCUIT# rows (deployment-wide and per workspace) when it closes.
    grantReadAndWrites(aggregatesTable, role, ['PutItem', 'UpdateItem']);
    grantKeyScopedWrites(aggregatesTable, role, ['DeleteItem'], CIRCUIT_ROW_PARTITIONS);
    processingQueue.grantSendMessages(role);
    // Write-only (IAM-1): ingestors only `put_object` raw/<source>/... (a deployment-wide run) and ws/{ws}/raw/<source>/...
    // (a run in a workspace; plugins/_shared/raw_archive.py, raw_original.py). No read and no delete: only
    // voc-retention may delete customer data (docs/source-policies.md). The workspace segment is pinned to one id
    // (WORKSPACE_ID_PATTERN: IAM's `*` would also match `/`, reaching e.g. `ws/{ws}/silver/raw/…`).
    rawDataBucket.grantPut(role, `${RAW_LAYER_PREFIX}*`);
    rawDataBucket.grantPut(role, `${WORKSPACE_RAW_LAYER_PREFIX}*`);
    kmsKey.grantEncryptDecrypt(role);
    // The deployment-wide run's shared secret, until phase 2's last slice removes that path. (A run in a workspace
    // reads its own plugin's parameters: grantOwnParameters, per plugin.)
    apiSecrets.grantRead(role);
    role.addToPolicy(piiDetectionStatement()); // source PII policy (docs/source-policies.md)

    return role;
  }
}
