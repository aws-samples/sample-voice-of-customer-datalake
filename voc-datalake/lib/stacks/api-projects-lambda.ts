/**
 * VocApiStack's Projects API Lambda and the table environment its async jobs share.
 * Resources are created on the stack itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { stackModelArns } from '../utils/model-allowlist';
import { PROJECTS_API_FUNCTION_BASE_NAME } from '../utils/function-names';
import type { ApiStackContext } from './api-context';
import { grantMarketplaceSubscription } from './api-marketplace';

export interface ProjectsLambda {
  projectsLambda: lambda.Function;
  projectsRole: iam.Role;
  /** The tables the project workflows read or write. */
  projectTablesEnvironment: Record<string, string>;
}

export function createProjectsLambda(ctx: ApiStackContext): ProjectsLambda {
  const { stack, allowedOrigin, apiLayer, apiCode: createApiLambdaCode } = ctx;
  const {
    feedbackTable, aggregatesTable, projectsTable, jobsTable, kmsKey, rawDataBucket, researchStateMachine,
    cdnSigningSecretArn, cdnSigningKeyPairId, avatarsCdnUrl, prototypesCdnUrl, userPool,
  } = ctx.props;

  // Projects API
  const projectsRole = ctx.role('ProjectsLambdaRole');
  feedbackTable.grantReadData(projectsRole);
  aggregatesTable.grantReadWriteData(projectsRole);
  projectsTable.grantReadWriteData(projectsRole);
  jobsTable.grantReadWriteData(projectsRole);
  kmsKey.grantEncryptDecrypt(projectsRole);
  projectsRole.addToPolicy(new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [researchStateMachine.stateMachineArn] }));
  // The Bedrock grant gets its own customer-managed policy instead of the
  // role's default inline policy: two ARNs per allowlisted model (eight models
  // since 3.07.00) pushed that inline policy past 70% of the role's 10,240-char
  // inline quota (api-stack-mcp.test.ts). Same statement, same resources — only
  // where it is stored changes, so no permission is widened.
  const projectsBedrockPolicy = new iam.ManagedPolicy(stack, 'ProjectsBedrockInvokePolicy', {
    roles: [projectsRole],
    statements: [new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        ...stackModelArns(stack),
        // Persona avatar image generation. Single-sourced in model-allowlist.ts
        // so the grant tracks the model through its EOL migration.
        ctx.avatarImageModelArn,
      ],
    })],
  });
  // The image model is a Marketplace listing (issue #274).
  grantMarketplaceSubscription(projectsRole);

  rawDataBucket.grantReadWrite(projectsRole, 'avatars/*');
  // Product context: projects API needs to issue presigned PUT URLs, read extracted text, delete docs.
  rawDataBucket.grantReadWrite(projectsRole, 'projects/*/product_docs/*');
  // Duplicating a prototype document copies its HTML (projects.py _copy_prototype_html).
  rawDataBucket.grantReadWrite(projectsRole, 'prototypes/*');
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

  const projectsLambda = new lambda.Function(stack, 'ProjectsApi', {
    // Built from the shared constant: the agent conductor and persona panel
    // (VocProcessingStack) invoke this function by the same deterministic name.
    functionName: ctx.uniqueName(PROJECTS_API_FUNCTION_BASE_NAME),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'projects_handler.lambda_handler',
    code: createApiLambdaCode('projects_handler.py'),
    role: projectsRole,
    timeout: cdk.Duration.seconds(30),
    // Power Tuning 2026-10-06, balanced, see voc-e2e/verify/power-tuning (lib/sizing/policy.ts)
    memorySize: 1024, // CPU-bound: memory buys vCPU; keep CPU <= 70% of the share
    environment: {
      ...projectTablesEnvironment,
      RESEARCH_STATE_MACHINE_ARN: researchStateMachine.stateMachineArn,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      AVATARS_CDN_URL: avatarsCdnUrl,
      PROTOTYPES_CDN_URL: prototypesCdnUrl,
      CDN_SIGNING_SECRET_ARN: cdnSigningSecretArn,
      CDN_SIGNING_KEY_PAIR_ID: cdnSigningKeyPairId,
      USER_POOL_ID: userPool.userPoolId,
      ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: 'voc-projects-api',
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('ProjectsApiLogs', ctx.uniqueName('voc-projects-api')),
  });
  // Like the role's default policy, attached before the function can be invoked.
  projectsLambda.node.addDependency(projectsBedrockPolicy);

  return { projectsLambda, projectsRole, projectTablesEnvironment };
}
