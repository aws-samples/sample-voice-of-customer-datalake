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
 * - `infrastructure.ingestor.browser`: sessions of the deployment's AgentCore
 *   browser (lib/stacks/ingestion-browser.ts: its own Web Bot Auth browser, or the
 *   AWS-managed `aws.browser.v1` with `-c webReviewsBotAuth=false`): Start/Stop on that
 *   browser's ARN only, Start and SaveBrowserSessionProfile on its profile's ARN when it
 *   has one; the automation-stream connect, which has no resource type, on `*` — the
 *   web_reviews plugin.
 * - `infrastructure.ingestor.webSearch`: a target read through Amazon Bedrock web
 *   search (`method: bedrock_web_search`, and `auto`'s second step): `bedrock-mantle:CreateInference` on the
 *   account's default mantle project (the Responses API; the GPT allowlist,
 *   lib/utils/web-search-models.ts, is enforced in code) and
 *   `bedrock-websearch:InvokeSearch` / `InvokeFetch` on `*` held to the deployment's
 *   region (`aws:RequestedRegion`), as the Bedrock web search IAM guide grants them;
 *   never `bedrock-websearch:ExternalWebAccess`, so Fetch reads Amazon's cache only. And
 *   `auto`'s last step, AgentCore Web Search's snippets (plugins/web_reviews/ingestor/snippet_reader.py):
 *   `bedrock-agentcore:InvokeWebSearch` on the AWS-managed tool of the deployment's region only,
 *   `arn:<partition>:bedrock-agentcore:<region>:aws:tool/web-search.v1` (the AgentCore developer guide's grant:
 *   the account field is the literal `aws`, the tool's owner).
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
 * - a GitHub App sign-in (7.45.00, the github_issues plugin alone, only with the
 *   engineering agents on): lambda:InvokeFunction on the GitHub Apps' token function by
 *   name (voc-engineering-app-tokens, VocProcessingStack, which deploys later), for a
 *   deployment-wide run's read-only Issues tokens (`environmentFor` names it to the
 *   function). It reads the App's key with its own role; this one never does.
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
import { grantWorkspaceStatusRead } from '../utils/workspace-resolution-grants';
import { grantWorkspaceParameterRead } from '../utils/workspace-secrets';
import { mantleInferenceStatement } from '../utils/web-search-models';
import { APP_TOKENS_FUNCTION_ENV, GITHUB_APP_SIGN_IN_PLUGIN, engineeringAppTokens } from './engineering-app-tokens';
import { RAW_LAYER_PREFIX, WORKSPACE_ID_PATTERN, WORKSPACE_RAW_LAYER_PREFIX } from './core-buckets';

/**
 * The circuit breaker's own rows, which it deletes when it closes (plugins/_shared/circuit_breaker.py): the
 * deployment-wide `CIRCUIT#<plugin>` / `TRIPPED`, and one per workspace, `WS#{ws}#CIRCUIT#<plugin>`. The workspace
 * segment is exactly one id (WORKSPACE_ID_PATTERN), so `WS#{ws}#SOURCE#x#CIRCUIT#y` is out of reach; a `CIRCUIT#`
 * partition is the breaker's alone. The integrations API clears the same rows (lib/stacks/api-data-lambdas.ts).
 */
export const CIRCUIT_ROW_PARTITIONS =['CIRCUIT#*', `WS#${WORKSPACE_ID_PATTERN}#CIRCUIT#*`];

/**
 * The web_reviews plugin's learned methods (lambda/shared/web_review_methods.py): the deployment-wide
 * `WEB_REVIEWS#METHODS` partition and one per workspace, `WS#{ws}#WEB_REVIEWS#METHODS` (one id, no wildcard after it).
 * The ingestor writes them with every ingestor role's voc-aggregates Put (its view refuses another workspace's key);
 * the integrations API's "Re-check methods" deletes one site's row there (lib/stacks/api-data-lambdas.ts).
 */
export const WEB_REVIEW_METHOD_PARTITIONS = ['WEB_REVIEWS#METHODS', `WS#${WORKSPACE_ID_PATTERN}#WEB_REVIEWS#METHODS`];
/** The scheduled tick's claim keys in voc-idempotency: `ingestor#fanout#{plugin}#{event id}` (base_ingestor.py). */
const FAN_OUT_CLAIM_PREFIX = 'ingestor#fanout#';

/** What every ingestor role is granted: watermarks, aggregates, queue, raw bucket, KMS, secrets, Comprehend PII detection. */
export interface BaseIngestionGrants {
  watermarksTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
  /** voc-workspaces: every role reads a workspace's `META` status (pk, sk, status only); a scheduled role also the
   *  tick's list of the workspaces that enabled its plugin. */
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
  /** The stack's prefix-aware names: the GitHub Apps' token function's (engineering-app-tokens.ts engineeringAppTokens). */
  uniqueName: (baseName: string) => string;
}

/** What decides whether a plugin's ingestor needs a role of its own. */
export interface IngestorRoleNeeds {
  bedrock: boolean;
  /** The browser its sessions run on (`infrastructure.ingestor.browser`); undefined for a plugin without one. */
  browser?: BrowserGrant;
  /** Amazon Bedrock web search through the Responses API (`infrastructure.ingestor.webSearch`). */
  webSearch?: boolean;
  /** The plugin's schedule rule name; undefined for an unscheduled plugin. */
  scheduleRuleName: string | undefined;
  /** The plugin's function name: a scheduled role may invoke this function, and only it (the tick's fan-out). */
  functionName: string;
  /** Job-end notices (`infrastructure.ingestor.jobNotices`): a dedicated role, so no other plugin may publish. */
  jobNotices?: boolean;
}

/** Whether a plugin's needs call for a role of its own (else the shared one). */
function needsOwnRole({ bedrock, browser, webSearch = false, scheduleRuleName, jobNotices = false }: IngestorRoleNeeds): boolean {
  return bedrock || browser !== undefined || webSearch || scheduleRuleName !== undefined || jobNotices;
}

/** The AWS-managed AgentCore browser: an `aws`-owned resource, one per region. */
export const MANAGED_BROWSER_ID = 'aws.browser.v1';
/** Resource-scoped AgentCore browser actions (the service authorization reference lists `browser*`). */
export const BROWSER_SESSION_ACTIONS = ['bedrock-agentcore:StartBrowserSession', 'bedrock-agentcore:StopBrowserSession'];
/** Saving a session's cookies and local storage to a profile: on the browser AND the profile (both resource types). */
export const BROWSER_PROFILE_SAVE_ACTION = 'bedrock-agentcore:SaveBrowserSessionProfile';
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
    + 'to the one browser the role drives (the AWS-managed aws.browser.v1, or the deployment\'s own Web Bot Auth browser)',
  findings: ['Resource::*'],
};

/** Amazon Bedrock web search and its cached fetch; `bedrock-websearch:ExternalWebAccess` is never granted. */
export const WEB_SEARCH_ACTIONS = ['bedrock-websearch:InvokeSearch', 'bedrock-websearch:InvokeFetch'];

/** AgentCore Web Search (`InvokeWebSearch`), on the AWS-managed tool only (the web_reviews `auto` cascade's last step). */
export const AGENTCORE_WEB_SEARCH_ACTION = 'bedrock-agentcore:InvokeWebSearch';
/** The AWS-managed AgentCore Web Search tool's id (its ARN's resource name). */
const AGENTCORE_WEB_SEARCH_TOOL = 'web-search.v1';

/** The AWS-managed AgentCore Web Search tool of the stack's region: an `aws`-owned resource, like aws.browser.v1. */
function agentCoreWebSearchToolArn(stack: cdk.Stack): string {
  return stack.formatArn({ service: 'bedrock-agentcore', account: 'aws', resource: 'tool', resourceName: AGENTCORE_WEB_SEARCH_TOOL });
}

/** The cdk-nag reason for web search on `*` (held to the region), on a web-search-capable role. */
const WEB_SEARCH_STAR_REASON = 'bedrock-websearch:InvokeSearch/InvokeFetch are granted on "*" as the Amazon Bedrock '
  + 'web search IAM guide grants them, held to the deployment\'s region by aws:RequestedRegion; ExternalWebAccess is not '
  + 'granted, so Fetch reads the Bedrock cache only';

/** The `Resource::*` acknowledgement of a role with a browser and/or web search: one entry naming every reason. */
function starAcknowledgement(browser: boolean, webSearch: boolean): NagAck {
  const reasons = [...(browser ? [BROWSER_STREAM_SUPPRESSION.reason] : []), ...(webSearch ? [WEB_SEARCH_STAR_REASON] : [])];
  return { ...BROWSER_STREAM_SUPPRESSION, reason: reasons.join('; ') };
}

/** A web-search-capable role's statements: the Responses API on the default project, search and cached fetch, and
 *  AgentCore Web Search on the region's managed tool. */
function webSearchStatements(stack: cdk.Stack): iam.PolicyStatement[] {
  return [
    mantleInferenceStatement(stack),
    new iam.PolicyStatement({
      actions: WEB_SEARCH_ACTIONS, resources: ['*'], conditions: { StringEquals: { 'aws:RequestedRegion': stack.region } },
    }),
    new iam.PolicyStatement({ actions: [AGENTCORE_WEB_SEARCH_ACTION], resources: [agentCoreWebSearchToolArn(stack)] }),
  ];
}

/** The browser a role may start sessions on, and the profile those sessions load and save (when there is one). */
export interface BrowserGrant {
  /** `arn:…:aws:browser/aws.browser.v1`, or the deployment's `arn:…:<account>:browser-custom/<id>`. */
  readonly arn: string;
  /** `arn:…:<account>:browser-profile/<id>`; undefined: sessions start without a profile. */
  readonly profileArn?: string;
}

/** The AWS-managed browser of the stack's region. */
export function managedBrowserArn(stack: cdk.Stack): string {
  return stack.formatArn({ service: 'bedrock-agentcore', account: 'aws', resource: 'browser', resourceName: MANAGED_BROWSER_ID });
}

/**
 * A browser-capable role's statements: Start/Stop on the browser; with a profile, Start (a session that loads it) and
 * SaveBrowserSessionProfile on the profile, and the save on the browser too (the action names both); the stream
 * connect on `*`.
 */
function browserSessionStatements({ arn, profileArn }: BrowserGrant): iam.PolicyStatement[] {
  const statements = [new iam.PolicyStatement({
    actions: profileArn ? [...BROWSER_SESSION_ACTIONS, BROWSER_PROFILE_SAVE_ACTION] : BROWSER_SESSION_ACTIONS,
    resources: [arn],
  })];
  if (profileArn) {
    statements.push(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:StartBrowserSession', BROWSER_PROFILE_SAVE_ACTION], resources: [profileArn],
    }));
  }
  statements.push(new iam.PolicyStatement({ actions: [BROWSER_STREAM_ACTION], resources: ['*'] }));
  return statements;
}

/** The statements of a role on the AWS-managed browser, without a profile (voc-design-capture). */
export function managedBrowserStatements(stack: cdk.Stack): iam.PolicyStatement[] {
  return browserSessionStatements({ arn: managedBrowserArn(stack) });
}

export class IngestorRoles {
  // Created on first use, so a deployment whose ingestors all have dedicated
  // roles gets no role nothing assumes.
  private shared?: iam.Role;

  constructor(private readonly stack: cdk.Stack, private readonly grants: BaseIngestionGrants) {}

  /** The role a plugin's ingestor runs as. */
  roleFor(
    pluginId: string,
    needs: IngestorRoleNeeds,
  ): iam.Role {
    const { bedrock, browser, webSearch = false, scheduleRuleName, functionName } = needs;
    const appTokens = this.appTokensFor(pluginId);
    if (!needsOwnRole(needs) && appTokens === undefined) {
      this.shared ??= this.newRole('IngestionLambdaRole');
      this.grantOwnParameters(this.shared, pluginId);
      return this.shared;
    }

    const role = this.newRole(`IngestorRole${capitalize(pluginId)}`);
    this.grantOwnParameters(role, pluginId);

    if (bedrock) {
      grantClaudeModels(role, 'invoke');
    }
    this.grantReading(role, browser, webSearch);

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
    // Built from the NAME: the token function is VocProcessingStack's, which deploys after this stack.
    if (appTokens !== undefined) grantInvokeByName(this.stack, role, [appTokens], 'GitHubAppTokens');

    return role;
  }

  /** The token function a plugin's ingestor signs in with a GitHub App through (github_issues, engineering on). */
  private appTokensFor(pluginId: string): string | undefined {
    return pluginId === GITHUB_APP_SIGN_IN_PLUGIN ? engineeringAppTokens(this.stack, this.grants.uniqueName) : undefined;
  }

  /** The environment a plugin's function needs for its role's grants: the token function's name, for the App sign-in. */
  environmentFor(pluginId: string): Record<string, string> {
    const appTokens = this.appTokensFor(pluginId);
    return appTokens === undefined ? {} : { [APP_TOKENS_FUNCTION_ENV]: appTokens };
  }

  /** A browser plugin's sessions and a web-search plugin's Responses API and cached search, each `*` acknowledged. */
  private grantReading(role: iam.Role, browser: BrowserGrant | undefined, webSearch: boolean): void {
    const statements = [
      ...(browser ? browserSessionStatements(browser) : []), ...(webSearch ? webSearchStatements(this.stack) : []),
    ];
    for (const statement of statements) role.addToPolicy(statement);
    if (statements.length > 0) acknowledgeNag(role, [starAcknowledgement(browser !== undefined, webSearch)]);
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
      watermarksTable, aggregatesTable, workspacesTable, processingQueue, rawDataBucket, kmsKey, apiSecrets,
    } = this.grants;
    watermarksTable.grantReadWriteData(role);
    // Run rows and counters (Put + Update, _shared/base_ingestor.py, the webscraper), and a workspace watermark's
    // directory row (`WS#{ws}#WATERMARK_KEYS`: its key alone, put unconditionally each time, so idempotent;
    // base_ingestor.py `_list_watermark`; the hard delete finds every watermark by it); the circuit breaker
    // (_shared/circuit_breaker.py) deletes only its own CIRCUIT# rows (deployment-wide and per workspace) when it closes.
    grantReadAndWrites(aggregatesTable, role, ['PutItem', 'UpdateItem']);
    // A run in a workspace (and the tick, per workspace) reads its META status first: GetItem of `WS#*` held to pk, sk
    // and status (base_ingestor.py `workspace_active`), so a workspace being deleted gets no new data.
    grantWorkspaceStatusRead(role, workspacesTable);
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
