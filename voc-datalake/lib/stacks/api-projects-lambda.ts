/**
 * VocApiStack's Projects API Lambda and the table environment its async jobs share.
 * Resources are created on the stack itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { grantClaudeModels } from '../utils/claude-model-grant';
import { appVersion } from '../utils/connector-version';
import { PROJECTS_API_FUNCTION_BASE_NAME } from '../utils/function-names';
import type { ApiStackContext } from './api-context';
import { grantMarketplaceSubscription } from './api-marketplace';
import { grantKeyScopedWrites, grantReadAndWrites } from '../utils/table-write-grants';
import { embeddingModelArn } from '../utils/model-allowlist';
import { grantWorkspaceObjects } from '../utils/workspace-object-deletes';
import { grantWorkspaceResolution } from '../utils/workspace-resolution-grants';
import { WORKSPACE_LIBRARY_PREFIX } from './core-buckets';
import { grantVoiceSessions } from './api-voice-sessions';
import {
  ASSIST_WORKER_ENV, PROJECTS_ASSIST_FUNCTION_BASE_NAME, assistWorkerName, createAssistWorker, grantAssistWorkerInvoke,
} from './api-assist-workers';

export interface ProjectsLambda {
  projectsLambda: lambda.Function;
  /** Its 15-minute assist twin (api-assist-workers.ts): same role, code and environment. */
  projectsAssistWorker: lambda.Function;
  projectsRole: iam.Role;
  /** The tables the project workflows read or write. */
  projectTablesEnvironment: Record<string, string>;
}

/** CDK's `grantReadData` actions but its stream reads, and its `grantWriteData` writes (lib/utils/table-write-grants.ts). */
const TABLE_READS = ['dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:Scan',
  'dynamodb:ConditionCheckItem', 'dynamodb:DescribeTable'] as const;
const TABLE_WRITES = ['dynamodb:BatchWriteItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'] as const;

export function createProjectsLambda(ctx: ApiStackContext): ProjectsLambda {
  const { stack, allowedOrigin, apiLayer, apiCode: createApiLambdaCode } = ctx;
  const {
    feedbackTable, aggregatesTable, projectsTable, jobsTable, kmsKey, rawDataBucket, researchStateMachine,
    cdnSigningSecretArn, cdnSigningKeyPairId, avatarsCdnUrl, prototypesCdnUrl, userPool, boardUserPool,
  } = ctx.props;

  // Projects API
  const projectsRole = ctx.role('ProjectsLambdaRole');
  // CDK's read grant without its stream reads: GetRecords and GetShardIterator act on a stream's ARN only, so on the
  // table's and its indexes' they grant nothing and only cost the role's inline quota (api-stack-mcp.test.ts; 7.62.00
  // made the room the Documents Library's grants need). The table's key: kmsKey.grantEncryptDecrypt below.
  feedbackTable.grant(projectsRole, ...TABLE_READS);
  // Prioritization rows, room votes, user flags (Put + Update). Its aggregates deletes are workspace rows only: a
  // Prioritization row with its ballots (PRIORITIZATION) and a closed vote's pointer (VOTING_SESSION_ROW).
  grantReadAndWrites(aggregatesTable, projectsRole, ['PutItem', 'UpdateItem']);
  grantKeyScopedWrites(aggregatesTable, projectsRole, ['DeleteItem'], ['PRIORITIZATION', 'VOTING_SESSION_ROW']);
  // Workspace artifacts (owner decision: really deleted when their owner deletes them): every write, batches included
  // (a project delete sweeps its rows and its jobs with batch_writer, lambda/api/projects.py delete_project).
  projectsTable.grant(projectsRole, ...TABLE_READS, ...TABLE_WRITES);
  jobsTable.grant(projectsRole, ...TABLE_READS, ...TABLE_WRITES);
  kmsKey.grantEncryptDecrypt(projectsRole);
  projectsRole.addToPolicy(new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [researchStateMachine.stateMachineArn] }));
  // Claude models through the stack's shared customer-managed policies (lib/utils/claude-model-grant.ts),
  // not the role's inline policy, which would pass 70% of its 10,240-char quota (api-stack-mcp.test.ts).
  const projectsClaudePolicies = grantClaudeModels(projectsRole, 'stream');
  // Persona avatar image generation: the in-Region image model, exact ARN. Single-sourced in
  // model-allowlist.ts so the grant tracks the model through its EOL migration.
  // With it, the Documents Library's embedder (7.62.00, lambda/shared/library_index.py): Titan Text Embeddings V2,
  // in-Region and invoked directly, its exact ARN; in the same statement, as the inline quota asks (api-stack-mcp.test.ts).
  projectsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: [ctx.avatarImageModelArn, embeddingModelArn(stack.region)],
  }));
  // The image model is a Marketplace listing (issue #274).
  grantMarketplaceSubscription(projectsRole);

  // Avatars, product docs (presigned PUT URLs, extracted text, deletes) and prototypes (a duplicated document copies
  // its HTML, projects.py _copy_prototype_html): read, write and delete, every version of a deleted object, in one
  // statement (lib/utils/workspace-object-deletes.ts).
  // The Documents Library's objects (7.62.00): the deployment's library/ and one workspace id's ws/{id}/library/ (the
  // presigned PUT and GET, the extracted text, every version of a deleted item; lambda/shared/library_objects.py).
  // With -c voicePersonas=true (7.69.00, api-voice-sessions.ts): a voice session's scratch files, and the relay's
  // presign and stop grants; nothing without it.
  const voice = grantVoiceSessions(ctx, projectsRole);
  grantWorkspaceObjects(rawDataBucket, projectsRole, ['avatars/*', 'projects/*/product_docs/*', 'prototypes/*',
    'library/*', `${WORKSPACE_LIBRARY_PREFIX}*`, ...voice.objectGlobs]);
  // Signs the avatar and prototype URLs returned by GET /projects/{id}.
  // Explicit statement rather than secret.grantRead(): that adds a KMS
  // key-policy entry naming this role, and the key lives in CoreStack, so it
  // would create a CoreStack -> ApiStack cycle. KMS access already comes from
  // kmsKey.grantEncryptDecrypt(projectsRole) above.
  projectsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [cdnSigningSecretArn],
  }));
  // Member picker / invite resolution for per-project sharing. ListUsers
  // only: the projects Lambda never administers users (that stays with
  // UsersApi), it just resolves a sub/prefix to an enabled user.
  projectsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['cognito-idp:ListUsers'],
    resources: [userPool.userPoolArn],
  }));
  // The Documents Library is a workspace's (7.62.00, lambda/shared/library_routes.py): its routes resolve the request's
  // X-Workspace-Id through the stack's one workspace-resolution policy (an attachment, no new resource) and write a
  // workspace's delete audit row (AUDIT#WS#*) through it. Without a platform admin's elevation (a member's own
  // membership only), so no Cognito Admin* read joins ListUsers above.
  const libraryWorkspaceEnv = grantWorkspaceResolution(ctx.props.workspacesTable, projectsRole);

  // The tables the project workflows read or write — the Projects API and the
  // generation jobs it dispatches. The persona importer reads no feedback and
  // lists its own.
  const projectTablesEnvironment = {
    PROJECTS_TABLE: projectsTable.tableName,
    FEEDBACK_TABLE: feedbackTable.tableName,
    AGGREGATES_TABLE: aggregatesTable.tableName,
    JOBS_TABLE: jobsTable.tableName,
  };

  // The 15-minute assist twin (api-assist-workers.ts): it shares this role, so
  // the invoke grant is by name, not grantInvoke().
  const projectsWorkerName = assistWorkerName(ctx, PROJECTS_ASSIST_FUNCTION_BASE_NAME);
  grantAssistWorkerInvoke(ctx, projectsRole, projectsWorkerName);

  const projectsProps: lambda.FunctionProps = {
    // Built from the shared constant: the agent conductor and persona panel
    // (VocProcessingStack) invoke this function by the same deterministic name.
    functionName: ctx.uniqueName(PROJECTS_API_FUNCTION_BASE_NAME),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'projects_handler.lambda_handler',
    code: createApiLambdaCode('projects_handler.py'),
    role: projectsRole,
    timeout: cdk.Duration.seconds(30),
    // Power Tuning 2026-10-06 pinned 1024; superseded 2026-10-18 (82.1 % p95 at 1024 MB → 1536); doubled
    // 2026-10-20 (75.4 % p95 at 1536 MB, lib/sizing/policy.ts)
    memorySize: 1769, // one vCPU 2026-10-23: single-threaded Python gains nothing above it (lib/sizing/policy.ts)
    environment: {
      ...projectTablesEnvironment,
      RESEARCH_STATE_MACHINE_ARN: researchStateMachine.stateMachineArn,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      AVATARS_CDN_URL: avatarsCdnUrl,
      PROTOTYPES_CDN_URL: prototypesCdnUrl,
      CDN_SIGNING_SECRET_ARN: cdnSigningSecretArn,
      CDN_SIGNING_KEY_PAIR_ID: cdnSigningKeyPairId,
      USER_POOL_ID: userPool.userPoolId,
      // The two pools the /review routes' board authorizer accepts (shared/engagement_identity.py
      // tells them apart by the verified `iss`).
      APP_USER_POOL_ID: userPool.userPoolId,
      BOARD_USER_POOL_ID: boardUserPool.userPoolId,
      ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: 'voc-projects-api',
      LOG_LEVEL: 'INFO',
      [ASSIST_WORKER_ENV]: projectsWorkerName,
      ...libraryWorkspaceEnv,
      ...voice.environment,
      // The release this function runs (7.48.00): the review registries' backfill reads it (with the operator's own
      // credentials) and writes its marker only once every writer of links, threads and projects runs 7.48.0 or later.
      APP_VERSION: appVersion(),
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('ProjectsApiLogs', ctx.uniqueName('voc-projects-api')),
  };
  const projectsLambda = new lambda.Function(stack, 'ProjectsApi', projectsProps);
  // Like the role's default policy, attached before the function can be invoked.
  projectsLambda.node.addDependency(...projectsClaudePolicies);
  const projectsAssistWorker = createAssistWorker(ctx, 'ProjectsAssistWorker', {
    // The twin keeps its own size: the 2026-10-18 raise was measured on the REST path (lib/sizing/policy.ts).
    baseName: PROJECTS_ASSIST_FUNCTION_BASE_NAME, apiProps: projectsProps, memorySize: 1024,
  });
  projectsAssistWorker.node.addDependency(...projectsClaudePolicies);

  return { projectsLambda, projectsAssistWorker, projectsRole, projectTablesEnvironment };
}
