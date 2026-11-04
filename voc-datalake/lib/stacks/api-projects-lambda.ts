/**
 * VocApiStack's Projects API Lambda and the table environment its async jobs share.
 * Resources are created on the stack itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { grantClaudeModels } from '../utils/claude-model-grant';
import { PROJECTS_API_FUNCTION_BASE_NAME } from '../utils/function-names';
import type { ApiStackContext } from './api-context';
import { grantMarketplaceSubscription } from './api-marketplace';
import { grantKeyScopedWrites, grantReadAndWrites } from '../utils/table-write-grants';
import { grantWorkspaceObjects } from '../utils/workspace-object-deletes';
import { FEATURE_REQUESTS_TABLE_ENV, grantFeatureRequestEvidenceRead } from '../utils/feature-request-evidence-grant';
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

export function createProjectsLambda(ctx: ApiStackContext): ProjectsLambda {
  const { stack, allowedOrigin, apiLayer, apiCode: createApiLambdaCode } = ctx;
  const {
    feedbackTable, aggregatesTable, projectsTable, jobsTable, kmsKey, rawDataBucket, researchStateMachine,
    cdnSigningSecretArn, cdnSigningKeyPairId, avatarsCdnUrl, prototypesCdnUrl, userPool, boardUserPool,
    featureRequestsTable,
  } = ctx.props;

  // Projects API
  const projectsRole = ctx.role('ProjectsLambdaRole');
  feedbackTable.grantReadData(projectsRole);
  // Prioritization rows, room votes, user flags (Put + Update). Its aggregates deletes are workspace rows only: a
  // Prioritization row with its ballots (PRIORITIZATION) and a closed vote's pointer (VOTING_SESSION_ROW).
  grantReadAndWrites(aggregatesTable, projectsRole, ['PutItem', 'UpdateItem']);
  grantKeyScopedWrites(aggregatesTable, projectsRole, ['DeleteItem'], ['PRIORITIZATION', 'VOTING_SESSION_ROW']);
  // Workspace artifacts (owner decision: really deleted when their owner deletes them): every write, batches included
  // (a project delete sweeps its rows and its jobs with batch_writer, lambda/api/projects.py delete_project).
  projectsTable.grantReadWriteData(projectsRole);
  jobsTable.grantReadWriteData(projectsRole);
  kmsKey.grantEncryptDecrypt(projectsRole);
  // Board requests as evidence: the persona / research wizards' live count (feedback-preview).
  grantFeatureRequestEvidenceRead(featureRequestsTable, projectsRole);
  projectsRole.addToPolicy(new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [researchStateMachine.stateMachineArn] }));
  // Claude models through the stack's shared customer-managed policies (lib/utils/claude-model-grant.ts),
  // not the role's inline policy, which would pass 70% of its 10,240-char quota (api-stack-mcp.test.ts).
  const projectsClaudePolicies = grantClaudeModels(projectsRole, 'stream');
  // Persona avatar image generation: the in-Region image model, exact ARN. Single-sourced in
  // model-allowlist.ts so the grant tracks the model through its EOL migration.
  projectsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: [ctx.avatarImageModelArn],
  }));
  // The image model is a Marketplace listing (issue #274).
  grantMarketplaceSubscription(projectsRole);

  // Avatars, product docs (presigned PUT URLs, extracted text, deletes) and prototypes (a duplicated document copies
  // its HTML, projects.py _copy_prototype_html): read, write and delete, every version of a deleted object, in one
  // statement (lib/utils/workspace-object-deletes.ts).
  grantWorkspaceObjects(rawDataBucket, projectsRole, ['avatars/*', 'projects/*/product_docs/*', 'prototypes/*']);
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
      [FEATURE_REQUESTS_TABLE_ENV]: featureRequestsTable.tableName,
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
