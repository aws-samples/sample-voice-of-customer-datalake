/**
 * VocApiStack's memory and agents APIs, the streaming AI assistant, S3 import
 * and the data explorer. Resources are created on the stack itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';
import { stackModelArns, embeddingModelArn } from '../utils/model-allowlist';
import { MEMORY_API_FUNCTION_BASE_NAME } from '../utils/function-names';
import { snapStartFunctionProps } from '../utils/snapstart';
import { PII_REDACTION_ENV, piiDetectionStatement } from '../utils/pii-redaction';
import type { ApiStackContext } from './api-context';

/** The domain Lambdas the assistant delegates its read tools to. */
export interface AssistantDelegates {
  projectsLambda: lambda.Function;
  metricsLambda: lambda.Function;
  feedbackFormLambda: lambda.Function;
  settingsLambda: lambda.Function;
  scrapersLambda: lambda.Function;
}

export interface AssistantLambdas {
  memoryLambda: lambda.Function;
  agentsLambda: lambda.Function;
  chatStreamLambda: NodejsFunction;
  s3ImportLambda: lambda.Function;
  dataExplorerLambda: lambda.Function;
  /** The AgentCore web-search gateway, when deployed. */
  webSearch: { gatewayUrl: string; gatewayArn: string; toolName: string } | undefined;
}

export function createAssistantLambdas(ctx: ApiStackContext, delegates: AssistantDelegates): AssistantLambdas {
  const { stack, allowedOrigin, apiLayer, apiCode: createApiLambdaCode } = ctx;
  const { projectsLambda, metricsLambda, feedbackFormLambda, settingsLambda, scrapersLambda } = delegates;
  const {
    feedbackTable, aggregatesTable, memoryTable, agentsTable, conversationsTable, kmsKey, rawDataBucket, s3ImportBucket,
    processingQueueUrl, processingQueueArn, memoryExtractQueueUrl, memoryExtractQueueArn, agentRunStateMachine,
    avatarsCdnUrl, cdnSigningSecretArn, cdnSigningKeyPairId, webSearchGatewayUrl, webSearchGatewayArn, webSearchToolName,
  } = ctx.props;

  // Memory API — /memory/* (docs/memory.md). Its own Lambda and role: the
  // only holder of voc-memory WRITES outside the Processing workers, and the
  // only API Lambda that embeds (Titan V2, dedup on explicit adds and merges).
  // No DeleteItem: forget = tombstone + archive, restore undoes it. Page imports
  // keep their original under memory-imports/ (read + put, never delete) and
  // are extracted asynchronously by the memory-extract queue.
  const memoryRole = ctx.role('MemoryLambdaRole');
  memoryTable.grant(memoryRole, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query');
  // Flags (memory_reviewer), company objectives (alignment), category access, model picker — all GetItem.
  aggregatesTable.grant(memoryRole, 'dynamodb:GetItem');
  kmsKey.grantEncryptDecrypt(memoryRole);
  memoryRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [memoryExtractQueueArn] }));
  rawDataBucket.grantRead(memoryRole, 'memory-imports/*');
  rawDataBucket.grantPut(memoryRole, 'memory-imports/*');
  memoryRole.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    // 'memory' surface (review suggestions, screening) + the fixed embedder.
    resources: [...stackModelArns(stack), embeddingModelArn(stack.region)],
  }));

  const memoryLambda = new lambda.Function(stack, 'MemoryApi', {
    ...snapStartFunctionProps(), // GET /memory cold start (lib/utils/snapstart.ts)
    // Shared constant: the agent conductor invokes this by name (retrieve).
    functionName: ctx.uniqueName(MEMORY_API_FUNCTION_BASE_NAME),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'memory_handler.lambda_handler',
    code: createApiLambdaCode('memory_handler.py'),
    role: memoryRole,
    timeout: cdk.Duration.seconds(30),
    // Power Tuning 2026-10-06, balanced, see voc-e2e/verify/power-tuning (lib/sizing/policy.ts)
    memorySize: 1024, // CPU-bound: memory buys vCPU; keep CPU <= 70% of the share
    environment: {
      MEMORY_TABLE: memoryTable.tableName,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      MEMORY_EXTRACT_QUEUE_URL: memoryExtractQueueUrl,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: 'voc-memory-api',
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('MemoryApiLogs', ctx.uniqueName(MEMORY_API_FUNCTION_BASE_NAME)),
  });

  // Agents API — /agents/*, /workflows/* (docs/autonomous-agents.md). Writes
  // are admin-only in the handler. "Run now" writes the queued RUN row and
  // starts voc-agent-run; cancel marks the run and stops the execution. No
  // DeleteItem: DELETE /agents/{id} archives.
  const agentsRole = ctx.role('AgentsLambdaRole');
  agentsTable.grant(agentsRole, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query');
  // Category access (which agents a user may see), category config, model picker — all GetItem.
  aggregatesTable.grant(agentsRole, 'dynamodb:GetItem');
  kmsKey.grantEncryptDecrypt(agentsRole);
  agentRunStateMachine.grantStartExecution(agentsRole);
  agentsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['states:StopExecution', 'states:DescribeExecution'],
    // Executions of THIS machine only. Built from the machine's name token so
    // the stop grant can never reach the research or document workflows.
    resources: [stack.formatArn({
      service: 'states',
      resource: 'execution',
      resourceName: `${agentRunStateMachine.stateMachineName}:*`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    })],
  }));
  // `:*` is the EXECUTION name (one execution per run, named by run id) — the
  // machine itself is pinned, so this can reach no other workflow.
  NagSuppressions.addResourceSuppressions(agentsRole, [{
    id: 'AwsSolutions-IAM5',
    reason: 'StopExecution/DescribeExecution address executions by name, one per agent run (named by run_id); the state machine part of the ARN is pinned to voc-agent-run',
    appliesTo: [{ regex: '/Resource::arn:aws:states:.*:execution:<.*AgentRunStateMachine.*\\.Name>:\\*/' }],
  }], true);

  const agentsLambda = new lambda.Function(stack, 'AgentsApi', {
    functionName: ctx.uniqueName('voc-agents-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'agents_handler.lambda_handler',
    code: createApiLambdaCode('agents_handler.py'),
    role: agentsRole,
    timeout: cdk.Duration.seconds(30),
    // Power Tuning 2026-10-06, balanced, see voc-e2e/verify/power-tuning (lib/sizing/policy.ts)
    memorySize: 1024, // CPU-bound: memory buys vCPU; keep CPU <= 70% of the share
    environment: {
      AGENTS_TABLE: agentsTable.tableName,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      AGENT_RUN_STATE_MACHINE_ARN: agentRunStateMachine.stateMachineArn,
      ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: 'voc-agents-api',
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('AgentsApiLogs', ctx.uniqueName('voc-agents-api')),
  });

  // Chat Stream (Node.js — API Gateway response streaming, replaces Python Function URL)
  const chatStreamLambda = new NodejsFunction(stack, 'ChatStreamApi', {
    functionName: ctx.uniqueName('voc-chat-stream'),
    entry: path.join(__dirname, '../../lambda/stream/src/handler.ts'),
    // The nodeModules install step below pairs CDK's generated minimal
    // package.json with a copied lockfile. Without this, CDK discovers the
    // CDK app's root package-lock.json (which doesn't contain the stream
    // Lambda's deps) and `npm ci` fails with EUSAGE at bundling time.
    depsLockFilePath: path.join(__dirname, '../../lambda/stream/package-lock.json'),
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: 1024,
    timeout: cdk.Duration.minutes(5),
    environment: {
      // The unified AI assistant reads through the owning domain APIs by
      // invoking them directly with the caller's forwarded claims, so every
      // ownership/permission check stays in one place (the Python handler).
      // It never touches the projects table and never writes business data:
      // writes are client tools the SPA executes after the user approves them.
      // Its one write is the caller's OWN conversation (CONVERSATIONS_TABLE).
      PROJECTS_FUNCTION: projectsLambda.functionName,
      METRICS_FUNCTION: metricsLambda.functionName,
      FEEDBACK_FORMS_FUNCTION: feedbackFormLambda.functionName,
      SETTINGS_FUNCTION: settingsLambda.functionName,
      SCRAPERS_FUNCTION: scrapersLambda.functionName,
      // Memory recall (every run gets a <memory> DATA block) and the memory /
      // agents read tools. Approved writes still go through the SPA.
      MEMORY_FUNCTION: memoryLambda.functionName,
      AGENTS_FUNCTION: agentsLambda.functionName,
      FEEDBACK_TABLE: feedbackTable.tableName,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      // Server-side session persistence (lambda/stream/src/assistant/session/):
      // the run's conversation is saved while it streams, so a reload mid-answer
      // recovers it from GET /chat/conversations/{id}.
      CONVERSATIONS_TABLE: conversationsTable.tableName,
      // AI assistant ('chat' surface) default when no override is set —
      // mirrors model_config.py SURFACE_DEFAULTS['chat']. The per-surface
      // picker can override this at runtime via model-override.ts.
      BEDROCK_MODEL_ID: 'global.anthropic.claude-sonnet-5-5',
      AVATARS_CDN_URL: avatarsCdnUrl,
      // This Lambda emits persona avatar URLs in the persona_turn SSE event,
      // which the SPA renders directly, so it has to sign them too (issue #229).
      CDN_SIGNING_SECRET_ARN: cdnSigningSecretArn,
      CDN_SIGNING_KEY_PAIR_ID: cdnSigningKeyPairId,
      ALLOWED_ORIGIN: allowedOrigin,
    },
    bundling: {
      format: OutputFormat.ESM,
      mainFields: ['module', 'main'],
      externalModules: [
        '@aws-sdk/*',
        '@smithy/*',
      ],
      // These modules are imported directly at runtime. Bundle their pinned
      // versions instead of relying on whatever SDK the managed runtime
      // happens to hoist: web-search signing uses the Smithy modules and
      // credential provider; canonical project reads use client-lambda.
      // The packages are small.
      nodeModules: [
        '@aws-sdk/credential-provider-node',
        '@aws-sdk/client-lambda',
        '@smithy/protocol-http',
        '@smithy/signature-v4',
        // Reads the CloudFront URL-signing key. Pinned here for the same
        // reason as the three above: `externalModules: ['@aws-sdk/*']` would
        // otherwise leave it to whatever the managed runtime hoists.
        '@aws-sdk/client-secrets-manager',
      ],
    },
    logGroup: ctx.logGroup('ChatStreamLogs', ctx.uniqueName('voc-chat-stream')),
  });

  // Bedrock permissions — InvokeModelWithResponseStream. Grant every
  // allowlisted model so the 'chat' surface can be repointed via the picker.
  chatStreamLambda.addToRolePolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: stackModelArns(stack),
  }));
  // No Marketplace grant: the assistant converses with allowlisted TEXT models
  // only and merely signs existing avatar URLs; it never invokes the image model.
  // Signs the persona avatar URLs emitted in the persona_turn SSE event.
  // Explicit statement, not secret.grantRead() — same cycle reason as the
  // projects role. kmsKey.grantEncryptDecrypt(chatStreamLambda) below covers the CMK.
  chatStreamLambda.addToRolePolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue'],
    resources: [cdnSigningSecretArn],
  }));

  // DynamoDB permissions
  feedbackTable.grantReadData(chatStreamLambda);
  aggregatesTable.grantReadData(chatStreamLambda);
  // The caller's own conversation, saved while the run streams: GetItem (the
  // stored copy at run start) + conditional PutItem — nothing else (no Query,
  // no Delete, no Update). IAM cannot pin the partition to a per-caller
  // Cognito sub (no LeadingKeys variable for a REST/Lambda caller), so the
  // stream code enforces USER#{verified sub} on every key (session/store.ts,
  // pinned by session.test.ts). Pinned here by 'ChatStream (AI assistant) delegation'.
  // An explicit statement rather than table.grant(), which adds `<table>/index/*`.
  chatStreamLambda.addToRolePolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
    resources: [conversationsTable.tableArn],
  }));
  // No projects-table grant: the assistant is read-only server-side and
  // reaches project data only through the Projects API below.
  // Read-only server tools delegate to the canonical domain APIs (internal
  // invoke with the caller's claims) rather than reimplementing their reads.
  // Exactly these seven — pinned by 'ChatStream (AI assistant) delegation'.
  // One explicit statement on the unqualified ARNs, not grantInvoke (which
  // adds `<fn>.Arn:*`, every version and alias): the invoker calls by
  // unqualified name, as the MCP role does below.
  chatStreamLambda.addToRolePolicy(new iam.PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [projectsLambda, metricsLambda, feedbackFormLambda, settingsLambda, scrapersLambda, memoryLambda, agentsLambda].map((fn) => fn.functionArn),
  }));
  // Encrypt too: the conversations table's CMK encrypts the item it writes.
  kmsKey.grantEncryptDecrypt(chatStreamLambda);

  // Web search tool (AgentCore Gateway) — optional, opt-in per request.
  // Without the gateway the env vars stay unset and the tool is never
  // registered with the model. Collapse the three optional props into one
  // narrowed value so enablement is decided exactly once.
  const webSearch = webSearchGatewayUrl && webSearchGatewayArn && webSearchToolName
    ? { gatewayUrl: webSearchGatewayUrl, gatewayArn: webSearchGatewayArn, toolName: webSearchToolName }
    : undefined;
  if (webSearch) {
    chatStreamLambda.addEnvironment('WEB_SEARCH_GATEWAY_URL', webSearch.gatewayUrl);
    chatStreamLambda.addEnvironment('WEB_SEARCH_TOOL_NAME', webSearch.toolName);
    chatStreamLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeGateway'],
      resources: [webSearch.gatewayArn],
    }));
  }

  NagSuppressions.addResourceSuppressions(chatStreamLambda, [
    { id: 'AwsSolutions-L1', reason: 'Node.js 22 is the target runtime for the streaming Lambda — latest stable LTS' },
  ], true);

  // S3 Import API
  const s3ImportRole = ctx.role('S3ImportLambdaRole');
  s3ImportBucket.grantReadWrite(s3ImportRole);
  kmsKey.grantEncryptDecrypt(s3ImportRole);

  const s3ImportLambda = new lambda.Function(stack, 'S3ImportApi', {
    functionName: ctx.uniqueName('voc-s3-import-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 's3_import_handler.lambda_handler',
    code: createApiLambdaCode('s3_import_handler.py'),
    role: s3ImportRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 512, // CPU-bound: memory buys vCPU; keep CPU <= 70% of the share
    environment: { S3_IMPORT_BUCKET: s3ImportBucket.bucketName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-s3-import-api', LOG_LEVEL: 'INFO' },
    layers: [apiLayer],
    logGroup: ctx.logGroup('S3ImportApiLogs', ctx.uniqueName('voc-s3-import-api')),
  });

  // Data Explorer API
  // Raw data is immutable and customer data is never deleted: read + put
  // (new objects; the handler refuses to overwrite raw/), no s3:DeleteObject*,
  // and no dynamodb:DeleteItem — only the in-place UpdateItem edit.
  const dataExplorerRole = ctx.role('DataExplorerLambdaRole');
  rawDataBucket.grantRead(dataExplorerRole);
  rawDataBucket.grantPut(dataExplorerRole);
  dataExplorerRole.addToPolicy(new iam.PolicyStatement({
    effect: iam.Effect.DENY,
    actions: ['s3:PutObject', 's3:DeleteObject'],
    resources: [rawDataBucket.arnForObjects('prototypes/*')],
  }));
  feedbackTable.grantReadData(dataExplorerRole);
  feedbackTable.grant(dataExplorerRole, 'dynamodb:UpdateItem');
  // Read-only: the categories config a category edit is validated against
  // (shared/feedback_category.py, the same rules as FeedbackEditApi).
  aggregatesTable.grant(dataExplorerRole, 'dynamodb:GetItem');
  kmsKey.grantEncryptDecrypt(dataExplorerRole);
  dataExplorerRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));
  // A put to raw/ that is re-queued gets its source's PII policy first.
  dataExplorerRole.addToPolicy(piiDetectionStatement());

  const dataExplorerLambda = new lambda.Function(stack, 'DataExplorerApi', {
    functionName: ctx.uniqueName('voc-data-explorer-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'data_explorer_handler.lambda_handler',
    code: createApiLambdaCode('data_explorer_handler.py'),
    role: dataExplorerRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 512, // CPU-bound: memory buys vCPU; keep CPU <= 70% of the share
    environment: {
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      FEEDBACK_TABLE: feedbackTable.tableName,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      PROCESSING_QUEUE_URL: processingQueueUrl,
      ...PII_REDACTION_ENV,
      ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: 'voc-data-explorer-api',
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('DataExplorerApiLogs', ctx.uniqueName('voc-data-explorer-api')),
  });

  return { memoryLambda, agentsLambda, chatStreamLambda, s3ImportLambda, dataExplorerLambda, webSearch };
}
