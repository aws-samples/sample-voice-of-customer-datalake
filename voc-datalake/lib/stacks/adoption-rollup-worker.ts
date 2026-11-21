/**
 * The leadership view's daily rollup, `voc-adoption-rollup` (VocProcessingStack, 7.70.00; docs/leadership-view.md;
 * handler lambda/jobs/adoption_rollup/handler.py). Built like voc-cost-rollup (cost-rollup-worker.ts).
 *
 * At 03:05 UTC (an EventBridge rule: pay per use, no fixed cost) it rebuilds, for the deployment and every active
 * workspace, the last 24 months from the projects, and writes one whole item per scope and day.
 *
 * Least privilege (lib/stacks/adoption-rollup-worker.test.ts pins every statement, and what the role may not do):
 *   - every read is a Query (never a Scan, a GetItem or a batch read), each one held to its partitions and, but for
 *     the conversations' count, to the attributes it projects (`dynamodb:Attributes` and `dynamodb:Select`
 *     `SPECIFIC_ATTRIBUTES`: a Query that named no projection would read whole rows, and is refused):
 *       - voc-workspaces: the listing partition `WORKSPACES`, an id and a status;
 *       - voc-projects: the registries (`PROJECT_IDS`, `WS#<one id>#PROJECT_IDS`) and the project partitions
 *         (`PROJECT#*`, `WS#<one id>#PROJECT#*`), of `PROJECT_QUERY_ATTRIBUTES` only: keys, types, dates, how an
 *         artifact was made, a decision's verdict, date and evidence ids, a report's outcomes; the code projects a
 *         decision and a validation down to those (lambda/shared/adoption_rollup.py);
 *       - voc-conversations: its `gsi1-by-kind-updated-at` index, `assistant` only, `dynamodb:Select` `COUNT`: the role
 *         can count conversations and read none (no title, no message, no person);
 *       - voc-agents: the listing index's `AGENTS` partition (keys) and each agent's partition (`AGENT#*`: keys and a
 *         run's `started_at`);
 *   - voc-aggregates: PutItem only, held by `dynamodb:LeadingKeys` to `ADOPTION#ROLLUP` and `WS#<one id>#ADOPTION#ROLLUP`
 *     (no read, no update, no delete: a rerun overwrites the whole item);
 *   - no access to voc-feedback, no Bedrock: the job reads no feedback and calls no model;
 *   - the Core key, for the tables.
 * No reserved concurrency (a Workshop Studio account cannot spare one): two runs at once write the same whole items.
 * No async retry: the next day's run rebuilds a scope that was not written.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { LOG_RETENTION } from '../utils/log-retention';
import { pythonLambdaAsset } from '../utils/python-lambda-asset';
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import { scheduleWorker, workerRole } from '../utils/worker-lambda';
import { WORKSPACE_ID_PATTERN } from './core-buckets';
import { CONVERSATIONS_BY_KIND_INDEX } from './memory-workers';

const ADOPTION_ROLLUP_FUNCTION_BASE_NAME = 'voc-adoption-rollup';
const ADOPTION_ROLLUP_MEMORY_MB = 512;
/** The rollup items' partitions in voc-aggregates (lambda/shared/adoption.py `rollup_partition`), one id per pattern. */
export const ADOPTION_PARTITIONS = ['ADOPTION#ROLLUP', `WS#${WORKSPACE_ID_PATTERN}#ADOPTION#ROLLUP`];
/** The project registries and partitions it Queries (lambda/shared/project_keys.py), one workspace id per pattern. */
export const PROJECT_QUERY_PARTITIONS = ['PROJECT_IDS', `WS#${WORKSPACE_ID_PATTERN}#PROJECT_IDS`, 'PROJECT#*',
  `WS#${WORKSPACE_ID_PATTERN}#PROJECT#*`];
/** What a project Query may read: a registry row's id and delete mark (shared/project_tables.py `REGISTRY_PROJECTION`)
 *  and lambda/shared/adoption_rollup.py `PROJECT_ATTRIBUTES` (the test holds the two lists equal). */
export const PROJECT_QUERY_ATTRIBUTES = ['pk', 'sk', 'deleted_at', 'document_type', 'document_id', 'created_at',
  'origin', 'edit_kind', 'imported_from', 'copied_from', 'synthetic', 'decision', 'validation', 'results'];
/** The agents listing index (lambda/shared/indexes.py `AGENTS_LISTING_INDEX`, core-stack.ts). */
const AGENTS_LISTING_INDEX = 'gsi1-by-agents-listing';
/** The partition of voc-workspaces that lists every workspace (lambda/shared/platform_workspaces.py `LISTING_PK`). */
const WORKSPACE_LISTING_PK = 'WORKSPACES';

export interface AdoptionRollupWorkerProps {
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  aggregatesTable: dynamodb.ITable;
  projectsTable: dynamodb.ITable;
  workspacesTable: dynamodb.ITable;
  conversationsTable: dynamodb.ITable;
  agentsTable: dynamodb.ITable;
}

/** Only `jobs/adoption_rollup`, `jobs/__init__.py` and `shared/` reach this bundle (and its hash). */
function adoptionRollupCode(): lambda.Code {
  return pythonLambdaAsset('lambda', {
    exclude: [
      '/jobs/*', '!/jobs/__init__.py', '!/jobs/adoption_rollup/',
      '/aggregator/', '/api/', '/processor/', '/research/',
      ...WORKER_TREE_ASSET_EXCLUDES, ...PY_LAMBDA_ASSET_EXCLUDES,
    ],
    copy: [
      'mkdir -p /asset-output/jobs',
      'cp /asset-input/jobs/__init__.py /asset-output/jobs/',
      'cp -r /asset-input/jobs/adoption_rollup /asset-output/jobs/',
      'cp -r /asset-input/shared /asset-output/',
    ],
  });
}

/** A projected Query: `actions` Query on `resource`, of `partitions` and `attributes` only. */
function projectedQuery(sid: string, resource: string, partitions: string[], attributes: string[]): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid,
    actions: ['dynamodb:Query'],
    resources: [resource],
    conditions: {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': attributes },
      // Without it a Query that names no attribute would pass the ForAllValues test above and read whole rows.
      StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
    },
  });
}

/** The rollup's reads: every one a Query, each held to its partitions and attributes (or, the conversations, a count). */
function grantRollupReads(role: iam.Role, props: AdoptionRollupWorkerProps): void {
  const { projectsTable, workspacesTable, conversationsTable, agentsTable } = props;
  role.addToPolicy(projectedQuery('QueryWorkspaceListing', workspacesTable.tableArn, [WORKSPACE_LISTING_PK],
    ['pk', 'sk', 'workspace_id', 'status']));
  role.addToPolicy(projectedQuery('QueryProjects', projectsTable.tableArn, PROJECT_QUERY_PARTITIONS,
    PROJECT_QUERY_ATTRIBUTES));
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'CountAssistantConversations',
    actions: ['dynamodb:Query'],
    resources: [`${conversationsTable.tableArn}/index/${CONVERSATIONS_BY_KIND_INDEX}`],
    conditions: {
      'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['assistant'] },
      // A count only: DynamoDB answers how many, never a conversation.
      StringEquals: { 'dynamodb:Select': 'COUNT' },
    },
  }));
  role.addToPolicy(projectedQuery('QueryAgentListing', `${agentsTable.tableArn}/index/${AGENTS_LISTING_INDEX}`,
    ['AGENTS'], ['pk', 'sk', 'gsi1pk', 'gsi1sk']));
  role.addToPolicy(projectedQuery('QueryAgentRuns', agentsTable.tableArn, ['AGENT#*'], ['pk', 'sk', 'started_at']));
}

export function createAdoptionRollupWorker(scope: Construct, id: string, props: AdoptionRollupWorkerProps): lambda.Function {
  const worker = new Construct(scope, id);
  const { uniqueName, kmsKey, aggregatesTable } = props;
  const functionName = uniqueName(ADOPTION_ROLLUP_FUNCTION_BASE_NAME);

  const role = workerRole(worker, 'AdoptionRollupRole');
  grantRollupReads(role, props);
  grantKeyScopedWrites(aggregatesTable, role, ['PutItem'], ADOPTION_PARTITIONS);
  kmsKey.grantEncryptDecrypt(role);

  const fn = new lambda.Function(worker, 'AdoptionRollup', {
    functionName,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'jobs/adoption_rollup/handler.lambda_handler',
    code: adoptionRollupCode(),
    role,
    timeout: cdk.Duration.minutes(15),
    memorySize: ADOPTION_ROLLUP_MEMORY_MB,
    retryAttempts: 0,
    environment: {
      AGGREGATES_TABLE: aggregatesTable.tableName,
      PROJECTS_TABLE: props.projectsTable.tableName,
      WORKSPACES_TABLE: props.workspacesTable.tableName,
      CONVERSATIONS_TABLE: props.conversationsTable.tableName,
      AGENTS_TABLE: props.agentsTable.tableName,
      POWERTOOLS_SERVICE_NAME: ADOPTION_ROLLUP_FUNCTION_BASE_NAME,
      LOG_LEVEL: 'INFO',
    },
    layers: [props.layer],
    logGroup: new logs.LogGroup(worker, 'AdoptionRollupLogs', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });

  // 03:05 UTC daily, after the cost rollup (02:15): the day before is over in every timezone the view reports in UTC.
  scheduleWorker(worker, 'AdoptionRollupSchedule', fn, uniqueName('voc-adoption-rollup-schedule'),
    events.Schedule.cron({ hour: '3', minute: '5' }),
    events.RuleTargetInput.fromObject({ mode: 'scheduled' }));
  return fn;
}
