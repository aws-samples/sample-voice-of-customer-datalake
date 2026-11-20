/**
 * A workspace's hard delete, `voc-workspace-delete` (VocProcessingStack, docs/multi-workspace.md "Export and delete",
 * steps 3 and 4; handler lambda/jobs/workspace_delete/handler.py). Built like voc-workspace-export
 * (workspace-export-worker.ts): its own construct, invoked by name from the workspaces API in VocApiStack (Processing
 * deploys first; lib/stacks/api-workspace-delete.ts grants that invoke), and by itself at a hand-over.
 *
 * Its own role, exactly what its code calls (lib/stacks/workspace-delete-worker.test.ts pins every statement): the
 * sweeps' grants (lib/utils/workspace-delete-grants.ts, by sweep, each statement once), and for the job itself:
 *   - voc-workspaces: UpdateItem on its job rows (`WSDELETE`: the generation claim, the progress, the outcome), Query
 *     of a workspace's `WS#{one id}` (its META's status), PutItem and GetItem on `AUDIT#workspace-deletes` only (the
 *     completed row, read back after a retried put);
 *   - KMS (the tables' and the bucket's key), with kms:Decrypt denied where kms:ViaService is SSM; its own invoke.
 *     No Scan anywhere, no table delete, no SSM decrypt.
 *
 * Reserved concurrency 2 (free): one invocation runs per deleting workspace (the job row's generation claim), and two
 * workspaces deleting at once is far more than a deployment needs; a third waits in Lambda's throttling retries.
 * No async retry (`retryAttempts: 0`: a retried generation would race its own claim), and an invoke older than 40
 * minutes is dropped, never run late: a dropped hand-over leaves the job row's `progress_at` behind, and an hour later
 * the job reads failed and a platform admin resumes it (POST /platform/workspaces/{ws}/delete/resume).
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import { byCodeUnit } from '../utils/compare';
import { WORKSPACE_DELETE_FUNCTION_BASE_NAME } from '../utils/function-names';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { LOG_RETENTION } from '../utils/log-retention';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { pythonLambdaAsset } from '../utils/python-lambda-asset';
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import { type DeleteGrant, deleteGrants } from '../utils/workspace-delete-grants';
import { WORKSPACE_HARD_DELETE_ENV } from '../utils/workspace-hard-delete';
import { grantInvokeByName, workerRole } from '../utils/worker-lambda';
import { workspaceParameterEnv } from '../utils/workspace-secrets';
import { WORKSPACE_ID_PATTERN, WORKSPACE_OBJECTS_PREFIX } from './core-buckets';

/** Path-style handler: the bundle keeps `jobs/workspace_delete/` with `shared/` beside `jobs/`. */
const DELETE_HANDLER = 'jobs/workspace_delete/handler.lambda_handler';
/** At most this many deletes' invocations run at once in the deployment (reserved concurrency costs nothing). */
export const WORKSPACE_DELETE_RESERVED_CONCURRENCY = 2;
/** An invoke older than this is dropped, never run late (the header). */
export const WORKSPACE_DELETE_MAX_EVENT_AGE_MINUTES = 40;
/** Paged deletes and one tombstone put per item: I/O-bound. */
const DELETE_MEMORY_MB = 1024;
/** One workspace's partitions: every one (`#*`), and the workspace's own control partition (exactly `WS#{id}`). */
const ONE = WORKSPACE_ID_PATTERN;
const WORKSPACE_PARTITIONS = `WS#${ONE}#*`;
const WORKSPACE_CONTROL_PARTITION = `WS#${ONE}`;
/** The delete's job rows and the platform's delete audit partition in voc-workspaces (shared/workspace_deletes.py). */
export const DELETE_JOB_PARTITION = 'WSDELETE';
export const DELETE_AUDIT_PARTITION = 'AUDIT#workspace-deletes';
/** Where every tombstone lives in voc-aggregates (shared/ws_repo.py TOMBSTONE_PARTITION_PREFIX). */
export const TOMBSTONE_PARTITIONS = 'AUDIT#tombstone#*';
/** The control-plane rows of a workspace the job deletes (shared/ws_repo.py WorkspaceControlRows): its own
 * partition, its members' inverse rows, its forms' lookup rows, its plugin rows and its listing row. IAM pins only the
 * partition, so USER#*, FORM#*, PLUGIN#* and WORKSPACES reach other workspaces' rows too: the code builds the sort
 * key (`WS#{ws}`) or deletes only a row naming this workspace (`workspace_id`), tested. */
export const CONTROL_ROW_DELETES = [WORKSPACE_CONTROL_PARTITION, 'FORM#*', 'PLUGIN#*', 'USER#*', 'WORKSPACES'];
/** The indexes the sweeps read (lambda/shared/indexes.py). */
const FEEDBACK_BY_DATE_INDEX = 'gsi1-by-date';
const AGGREGATES_BY_METRIC_TYPE_INDEX = 'gsi1-by-metric-type';
const MEMORY_BY_STATUS_INDEX = 'gsi1-by-memory-status';
/** The memory partitions read by their own key (the personal memories through the status index). */
export const MEMORY_PARTITIONS = [`WS#${ONE}#MEM#company`, `WS#${ONE}#MEMCURSOR`, `WS#${ONE}#MEMIMPORT`,
  `WS#${ONE}#MEMEVT#*`];
/** A workspace project's partitions (lambda/shared/project_keys.py `project_partitions`): in voc-projects its own, its
 * document versions and its series' comment partitions (`comments_pk`, listed in its own partition), in voc-jobs and
 * voc-participants its own; and the workspace's registry of its project ids (`project_registry_pk`), in voc-projects.
 * With them, the workspace's Documents Library (7.62.00, lambda/shared/library_keys.py): its `LIBRARY` partition and
 * its items' passages, `LIBRARY_CHUNKS#{item}` (the `library` sweep). */
const PROJECT_PARTITION = `WS#${ONE}#PROJECT#*`;
export const PROJECTS_TABLE_PARTITIONS = [PROJECT_PARTITION, `WS#${ONE}#DOCUMENT_VERSIONS#PROJECT#*`,
  `WS#${ONE}#DCOMMENTS#*`, `WS#${ONE}#PROJECT_IDS`, `WS#${ONE}#LIBRARY`, `WS#${ONE}#LIBRARY_CHUNKS#*`];
const PROJECT_PARTITIONS_ELSEWHERE = [PROJECT_PARTITION];
/** A project id's claim (lambda/shared/ws_repo.py `PROJECT_ID#{id}` / `CLAIM`): deployment-wide by design, so IAM
 * reaches every claim; the code releases only one that names this workspace, of an id from its own registry. */
export const PROJECT_CLAIM_PARTITIONS = ['PROJECT_ID#*'];
/** A workspace's review links in voc-projects: its registry of link ids (lambda/shared/project_keys.py
 * `review_link_registry_pk`), read and batch-deleted, and each link's own row (`review_link_key`), batch-deleted by
 * its key alone, never read. */
export const REVIEW_LINK_REGISTRY = [`WS#${ONE}#DOCSHARE_IDS`];
export const REVIEW_LINK_ROWS = [`WS#${ONE}#DOCSHARE#*`];
/** A review link's routing row (lambda/shared/ws_repo.py `DOCSHARE#{id}` / `META`): deployment-wide by design (a
 * deployment's own link has the same key), so IAM reaches every one; the code deletes only a route naming this
 * workspace, of an id from its own registry, and never reads one. */
export const REVIEW_LINK_ROUTE_PARTITIONS = ['DOCSHARE#*'];
/** voc-conversations: a workspace's list of conversation owners and each owner's partition there
 * (lambda/shared/conversations.py), never the deployment's `USER#{sub}`. */
export const CONVERSATION_PARTITIONS = [`WS#${ONE}#CONVERSANTS`, `WS#${ONE}#USER#*`];
/** voc-participants: a workspace's index of its people's and lists' partitions and the partitions it names
 * (lambda/shared/participants_keys.py), never the deployment's `LIST#`, `PERSON#` or `EMAIL#` rows. */
export const PARTICIPANT_PARTITIONS = [`WS#${ONE}#PARTICIPANTS`, `WS#${ONE}#LIST#*`, `WS#${ONE}#PERSON#*`,
  `WS#${ONE}#EMAIL#*`];
/** What a keys-only Query may read of a row: its key alone (lambda/jobs/workspace_delete/sweeps.py `KEYS_ONLY`). */
const KEY_ATTRIBUTES = ['pk', 'sk'];

export interface WorkspaceDeleteWorkerProps {
  uniqueName: (baseName: string) => string;
  /** The deployment-prefixed base path of the workspaces' credentials parameters (`ctx.prefixed('voc/ws')`). */
  parameterBasePath: string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  feedbackTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
  workspacesTable: dynamodb.ITable;
  memoryTable: dynamodb.ITable;
  watermarksTable: dynamodb.ITable;
  /** voc-radar: a workspace's Radar settings (`WS#{id}#SETTINGS#radar`). */
  radarTable: dynamodb.ITable;
  /** voc-projects, voc-jobs, voc-participants: a workspace's projects, their registry and claims (the `projects` grant);
   * voc-participants also its people and lists (the `participants` grant). */
  projectsTable: dynamodb.ITable;
  jobsTable: dynamodb.ITable;
  participantsTable: dynamodb.ITable;
  /** voc-conversations: the members' conversations in the workspace and their owner list (the `conversations` grant). */
  conversationsTable: dynamodb.ITable;
  rawDataBucket: s3.IBucket;
  /** Every plugin id of the deployment (its PLUGIN#{p} rows and per-plugin partitions are found by them). */
  pluginIds: readonly string[];
}

const keys = (partitions: readonly string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [...partitions] } });

/** One Query statement on a table or one of its indexes, held to `partitions`. */
function query(role: iam.Role, resource: string, partitions: readonly string[]): void {
  role.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [resource],
    conditions: keys(partitions) }));
}

/** The sweep statements made so far, per role: actions and partitions → the statement (its tables added to it). */
const sweepStatements = new WeakMap<iam.Role, Map<string, iam.PolicyStatement>>();

/**
 * The batch deletes and the reads that find them, in ONE statement per set of actions and partitions, every table
 * that shares them added to it: the role writes many tables, and a statement each would take its inline policy past
 * IAM's size limit (CDK moves what does not fit to a managed policy). The tables share the deployment key, which the
 * role is granted once (createWorkspaceDeleteWorker).
 */
function sweep(role: iam.Role, tables: readonly dynamodb.ITable[], partitions: readonly string[],
  reads: readonly ('GetItem' | 'Query')[] = ['Query']): void {
  const actions = ['dynamodb:BatchWriteItem', ...reads.map((read) => `dynamodb:${read}`)];
  const made = sweepStatements.get(role) ?? new Map<string, iam.PolicyStatement>();
  sweepStatements.set(role, made);
  const shape = JSON.stringify([actions, partitions]);
  const existing = made.get(shape);
  if (existing !== undefined) {
    existing.addResources(...tables.map((table) => table.tableArn));
    return;
  }
  const statement = new iam.PolicyStatement({ actions, resources: tables.map((table) => table.tableArn),
    conditions: keys(partitions) });
  made.set(shape, statement);
  role.addToPolicy(statement);
}

/**
 * Staged from `lambda/`, pruned to `jobs/workspace_delete`, the export's page helpers (`jobs/workspace_export/
 * pages.py`, which the sweeps share), `aggregator/` (its counter key function, read as
 * scripts/retention/rebuild_aggregates.py reads it) and `shared/`.
 */
function deleteCode(): lambda.Code {
  return pythonLambdaAsset('lambda', {
    exclude: [
      ...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES,
      '/api/', '/processor/', '/research/',
      '/jobs/*', '!/jobs/__init__.py', '!/jobs/workspace_delete/', '!/jobs/workspace_export/',
      '/jobs/workspace_export/*', '!/jobs/workspace_export/__init__.py', '!/jobs/workspace_export/pages.py',
    ],
    copy: [
      'mkdir -p /asset-output/jobs/workspace_export',
      'cp /asset-input/jobs/__init__.py /asset-output/jobs/',
      'cp -r /asset-input/jobs/workspace_delete /asset-output/jobs/',
      'cp /asset-input/jobs/workspace_export/__init__.py /asset-input/jobs/workspace_export/pages.py '
        + '/asset-output/jobs/workspace_export/',
      'cp -r /asset-input/aggregator /asset-output/',
      'cp -r /asset-input/shared /asset-output/',
    ],
  });
}

/** The `credentials` grant: one workspace's credentials path listed and its parameters deleted, never read. */
function grantCredentials(stack: cdk.Stack, role: iam.Role, parameterBasePath: string): void {
  const path = `${parameterBasePath}/${ONE}/credentials`;
  const arn = (name: string) => stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: name,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME });
  // Listed WithDecryption=False, and kms:Decrypt through SSM denied outright (the role's kmsKey grant would
  // otherwise allow it, should the parameters ever share that key): no value can be read.
  role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetParametersByPath'], resources: [arn(path)] }));
  role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:DeleteParameters'], resources: [arn(`${path}/*`)] }));
  role.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.DENY,
    actions: ['kms:Decrypt'], resources: ['*'],
    conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } } }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'A workspace\'s hard delete deletes that workspace\'s plugin credentials parameters (voc/ws/{ws}/'
      + 'credentials/{plugin}, decision 19), the path built from the job row\'s workspace only; one workspace id '
      + 'segment of this deployment\'s path, listed without decryption, kms:Decrypt through SSM denied',
    findings: [resourceFinding(arn(`${path}/*`))],
  }]);
}

/** The grants on voc-aggregates (lib/utils/workspace-delete-grants.ts); false for a grant on another resource. */
function grantOnAggregates(role: iam.Role, which: DeleteGrant, aggregatesTable: dynamodb.ITable): boolean {
  switch (which) {
    case 'aggregates':
      sweep(role, [aggregatesTable], [WORKSPACE_PARTITIONS], ['GetItem', 'Query']);
      return true;
    case 'metricTypeIndex':
      query(role, `${aggregatesTable.tableArn}/index/${AGGREGATES_BY_METRIC_TYPE_INDEX}`, [WORKSPACE_PARTITIONS]);
      return true;
    case 'tombstones':
      grantKeyScopedWrites(aggregatesTable, role, ['PutItem'], [TOMBSTONE_PARTITIONS]);
      return true;
    case 'exportJobs':
      grantKeyScopedWrites(aggregatesTable, role, ['UpdateItem'], [`WS#${ONE}#JOB#export`]);
      return true;
    default:
      return false;
  }
}

/** Batch deletes of `partitions` of `table`, and a Query of them for the keys alone (`dynamodb:Attributes` pk and sk,
 * which must be named, and SPECIFIC_ATTRIBUTES: nothing else of a row is ever read; sweeps.py KEYS_ONLY). */
function sweepKeysOnly(role: iam.Role, table: dynamodb.ITable, partitions: readonly string[]): void {
  sweep(role, [table], partitions, []);
  role.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [table.tableArn],
    conditions: {
      ...keys(partitions),
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': KEY_ATTRIBUTES },
      StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      Null: { 'dynamodb:Attributes': 'false' },
    } }));
}

/** The `projects` grant (lib/utils/workspace-delete-grants.ts): the registry and each project's partitions read and
 * batch-deleted, one workspace's only; the ids' claims read and deleted (DeleteItem, conditioned in the code). */
function grantProjects(role: iam.Role, { projectsTable, jobsTable, participantsTable }: WorkspaceDeleteWorkerProps): void {
  sweep(role, [projectsTable], PROJECTS_TABLE_PARTITIONS);
  sweep(role, [jobsTable, participantsTable], PROJECT_PARTITIONS_ELSEWHERE);
  role.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:DeleteItem', 'dynamodb:GetItem'],
    resources: [projectsTable.tableArn], conditions: keys(PROJECT_CLAIM_PARTITIONS) }));
}

/** The `docshares` grant (lib/utils/workspace-delete-grants.ts): the review link registry read and batch-deleted,
 * the links' own rows batch-deleted, one workspace's only; the links' routing rows deleted (DeleteItem, conditioned
 * in the code). Neither a link nor a route is ever read. */
function grantReviewLinks(role: iam.Role, { projectsTable }: WorkspaceDeleteWorkerProps): void {
  sweep(role, [projectsTable], REVIEW_LINK_REGISTRY);
  sweep(role, [projectsTable], REVIEW_LINK_ROWS, []);
  role.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:DeleteItem'],
    resources: [projectsTable.tableArn], conditions: keys(REVIEW_LINK_ROUTE_PARTITIONS) }));
}

/** The grants built around voc-projects' rows outside a workspace (a project id's claim, a review link's route). */
const PROJECTS_TABLE_GRANTS: Partial<Record<DeleteGrant,
  (role: iam.Role, props: WorkspaceDeleteWorkerProps) => void>> = {
  projects: grantProjects,
  docshares: grantReviewLinks,
};

/** The grants whose sweep reads for the keys alone (`sweepKeysOnly`): the table and its partitions. */
const KEYS_ONLY_SWEEPS: Partial<Record<DeleteGrant,
  (props: WorkspaceDeleteWorkerProps) => readonly [dynamodb.ITable, readonly string[]]>> = {
  // One workspace's index and the list, person and address-guard partitions it names, never the deployment's: no
  // address or name is ever read.
  participants: (props) => [props.participantsTable, PARTICIPANT_PARTITIONS],
  // One workspace's owner list and its owners' partitions, never the deployment's USER#{sub}: no message, title or
  // first_at is ever read.
  conversations: (props) => [props.conversationsTable, CONVERSATION_PARTITIONS],
};

/** Each grant's statements (lib/utils/workspace-delete-grants.ts). */
function grant(scope: Construct, role: iam.Role, which: DeleteGrant, props: WorkspaceDeleteWorkerProps): void {
  const { feedbackTable, aggregatesTable, workspacesTable, memoryTable, watermarksTable, radarTable, rawDataBucket } = props;
  if (grantOnAggregates(role, which, aggregatesTable)) return;
  const onProjects = PROJECTS_TABLE_GRANTS[which];
  if (onProjects !== undefined) {
    onProjects(role, props);
    return;
  }
  const keysOnly = KEYS_ONLY_SWEEPS[which];
  if (keysOnly !== undefined) {
    const [table, partitions] = keysOnly(props);
    sweepKeysOnly(role, table, partitions);
    return;
  }
  switch (which) {
    case 'feedback':
      query(role, `${feedbackTable.tableArn}/index/${FEEDBACK_BY_DATE_INDEX}`, [`WS#${ONE}#DATE#*`]);
      sweep(role, [feedbackTable], [`WS#${ONE}#SOURCE#*`]);
      return;
    case 'watermarks':
      // BatchWriteItem alone (the watermarks are found through their directory rows in voc-aggregates).
      sweep(role, [watermarksTable], [WORKSPACE_PARTITIONS], []);
      return;
    case 'radar':
      // The workspace's Radar rows (sweeps.py `radar`): read and batch-deleted in its own partitions only.
      sweep(role, [radarTable], [WORKSPACE_PARTITIONS], ['GetItem', 'Query']);
      return;
    case 'memory':
      query(role, memoryTable.tableArn, MEMORY_PARTITIONS);
      query(role, `${memoryTable.tableArn}/index/${MEMORY_BY_STATUS_INDEX}`, [`WS#${ONE}#MEMSTATUS#personal#*`]);
      sweep(role, [memoryTable], [WORKSPACE_PARTITIONS], []);
      return;
    case 'objects': {
      const versionsOfOneWorkspace = { StringLike: { 's3:prefix': [WORKSPACE_OBJECTS_PREFIX] } };
      // ListBucketMultipartUploads takes no s3:prefix condition, so it is bucket-wide: the role could list every open
      // upload's key and upload id, other workspaces' and the deployment's too, but no object's data. Accepted
      // (docs/multi-workspace.md, step 4's IAM); the code lists one workspace's prefix (shared/ws_repo.py
      // WorkspaceObjectVersions.open_uploads, ExportObjects.open_uploads).
      const statements: [string[], string, Record<string, unknown> | undefined][] = [
        [['s3:ListBucketVersions'], rawDataBucket.bucketArn, versionsOfOneWorkspace],
        [['s3:ListBucketMultipartUploads'], rawDataBucket.bucketArn, undefined],
        [['s3:AbortMultipartUpload', 's3:DeleteObjectVersion'], rawDataBucket.arnForObjects(WORKSPACE_OBJECTS_PREFIX),
          undefined],
      ];
      for (const [actions, resource, conditions] of statements) {
        role.addToPolicy(new iam.PolicyStatement({ actions, resources: [resource], conditions }));
      }
      return;
    }
    case 'credentials':
      grantCredentials(cdk.Stack.of(scope), role, props.parameterBasePath);
      return;
    case 'controlRows':
      query(role, workspacesTable.tableArn, [WORKSPACE_CONTROL_PARTITION]);
      grantKeyScopedWrites(workspacesTable, role, ['DeleteItem'], CONTROL_ROW_DELETES);
      grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], ['SLUG#*'], ['deleted_at', 'pk', 'sk', 'workspace_id']);
      break;
    default:
      // The voc-aggregates grants (grantOnAggregates, above).
  }
}

/** The delete job (see the module comment). */
export function createWorkspaceDeleteWorker(scope: Construct, id: string,
  props: WorkspaceDeleteWorkerProps): lambda.Function {
  const worker = new Construct(scope, id);
  // The role's statements are past what CDK keeps in one inline policy (its estimate counts each ARN it cannot
  // resolve at synth as 150 characters): CDK moves the last of them to a managed policy of the role, which is as
  // binding (workspace-delete-worker.test.ts reads both). Its statements carry no sid: IAM counts their length.
  const { uniqueName, kmsKey, workspacesTable } = props;
  const functionName = uniqueName(WORKSPACE_DELETE_FUNCTION_BASE_NAME);
  const role = workerRole(worker, 'DeleteRole');
  for (const which of deleteGrants()) grant(worker, role, which, props);
  // The job's own row, its META check and its completed audit row (shared/workspace_deletes.py).
  grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], [DELETE_JOB_PARTITION]);
  // Its completed audit row: put, and read back after a retried put (one statement: the inline policy's size).
  role.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
    resources: [workspacesTable.tableArn], conditions: keys([DELETE_AUDIT_PARTITION]) }));
  kmsKey.grantEncryptDecrypt(role);
  grantInvokeByName(cdk.Stack.of(worker), role, [functionName], 'SelfInvoke');

  return new lambda.Function(worker, 'Delete', {
    functionName,
    role,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: DELETE_HANDLER,
    code: deleteCode(),
    layers: [props.layer],
    timeout: cdk.Duration.minutes(15),
    memorySize: DELETE_MEMORY_MB,
    reservedConcurrentExecutions: WORKSPACE_DELETE_RESERVED_CONCURRENCY,
    // A hidden re-drive would race the generation claim; a stale event is dropped, not run late.
    retryAttempts: 0,
    maxEventAge: cdk.Duration.minutes(WORKSPACE_DELETE_MAX_EVENT_AGE_MINUTES),
    environment: {
      FEEDBACK_TABLE: props.feedbackTable.tableName,
      AGGREGATES_TABLE: props.aggregatesTable.tableName,
      WORKSPACES_TABLE: workspacesTable.tableName,
      MEMORY_TABLE: props.memoryTable.tableName,
      WATERMARKS_TABLE: props.watermarksTable.tableName,
      RADAR_TABLE: props.radarTable.tableName,
      PROJECTS_TABLE: props.projectsTable.tableName,
      JOBS_TABLE: props.jobsTable.tableName,
      PARTICIPANTS_TABLE: props.participantsTable.tableName,
      CONVERSATIONS_TABLE: props.conversationsTable.tableName,
      RAW_DATA_BUCKET: props.rawDataBucket.bucketName,
      PLUGIN_IDS: JSON.stringify([...props.pluginIds].sort(byCodeUnit)),
      // Built only with the flag on (lib/utils/workspace-hard-delete.ts); the job refuses to run without it.
      [WORKSPACE_HARD_DELETE_ENV]: 'true',
      ...workspaceParameterEnv(props.parameterBasePath),
      POWERTOOLS_SERVICE_NAME: WORKSPACE_DELETE_FUNCTION_BASE_NAME,
      LOG_LEVEL: 'INFO',
    },
    logGroup: new logs.LogGroup(worker, 'DeleteLogs', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });
}
