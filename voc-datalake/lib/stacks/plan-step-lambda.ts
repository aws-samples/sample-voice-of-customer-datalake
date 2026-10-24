/**
 * `voc-plan-step` (VocProcessingStack) — runs ONE step of an approved assistant plan
 * (docs/assistant-plan-mode.md → "Runtime"). voc-agent-run invokes it directly, between the
 * conductor's `plan_prepare` (claims the step, re-checks the approver in Cognito) and
 * `plan_record`, so the conductor never executes a write and never waits on one.
 *
 * Built from lambda/stream (TypeScript) so tool definitions, the write → REST mapping and the
 * matching exist once. It acts with the synthetic claims the conductor built for the approver:
 *
 *   - read-only server tools of the step's pack, through the same domain APIs as the assistant;
 *   - the step's write, through the same REST route the SPA approval card calls;
 *   - a focused model call for `{{free}}` fields and think steps (surface `agent_worker`).
 *
 * Grants (exact): invoke on the domain API Lambdas below by unqualified name; Bedrock on the
 * allowlisted models; aggregates GetItem + Query (model settings, get_source_run's `SOURCE_RUN#…`
 * rows); feedback read (search_feedback in think steps, as the assistant's role has); KMS decrypt.
 * No table writes at all: every write is a domain API call that applies its own checks.
 *
 * Bundled exactly like the assistant (`ChatStreamApi`, api-assistant-lambdas.ts): the stream's own
 * lockfile, the AWS SDK left external, its directly imported clients pinned via `nodeModules`.
 * BEDROCK_INFERENCE_SCOPE (EU) is added to every Lambda by `applyInferenceScopeEnv`
 * (lib/utils/inference-scope.ts). No AVATARS_CDN_URL / CDN signing: a step's outputs are text and
 * ids, never a persona avatar URL.
 */
import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

import {
  AGENTS_API_FUNCTION_BASE_NAME, FEEDBACK_EDIT_API_FUNCTION_BASE_NAME, FEEDBACK_FORM_API_FUNCTION_BASE_NAME,
  INTEGRATIONS_API_FUNCTION_BASE_NAME, MEMORY_API_FUNCTION_BASE_NAME, METRICS_API_FUNCTION_BASE_NAME,
  PLAN_STEP_FUNCTION_BASE_NAME, PROJECTS_API_FUNCTION_BASE_NAME, SCRAPERS_API_FUNCTION_BASE_NAME,
  SETTINGS_API_FUNCTION_BASE_NAME,
} from '../utils/function-names';
import { stackModelArns } from '../utils/model-allowlist';
import { grantInvokeByName, workerRole } from '../utils/worker-lambda';

const STREAM_ROOT = path.join(__dirname, '../../lambda/stream');

/**
 * Env var → base name of each domain API the plan step invokes. The first seven are the streaming
 * assistant's delegates (same env names, lib/stacks/api-assistant-lambdas.ts); the last two serve
 * plan writes the assistant leaves to the SPA (app connectors / source runs, a feedback category).
 *
 * NOT the Users API (the assistant's eighth): every user-administration write is CARD_ONLY (never a
 * plan step) and a think step never gets the directory reads (`THINK_EXCLUDED_TOOLS` in
 * lambda/stream/src/plan-step/think.ts), so nothing a plan runs can reach it.
 */
export const PLAN_STEP_DELEGATES: Readonly<Record<string, string>> = {
  PROJECTS_FUNCTION: PROJECTS_API_FUNCTION_BASE_NAME,
  METRICS_FUNCTION: METRICS_API_FUNCTION_BASE_NAME,
  FEEDBACK_FORMS_FUNCTION: FEEDBACK_FORM_API_FUNCTION_BASE_NAME,
  SETTINGS_FUNCTION: SETTINGS_API_FUNCTION_BASE_NAME,
  SCRAPERS_FUNCTION: SCRAPERS_API_FUNCTION_BASE_NAME,
  MEMORY_FUNCTION: MEMORY_API_FUNCTION_BASE_NAME,
  AGENTS_FUNCTION: AGENTS_API_FUNCTION_BASE_NAME,
  INTEGRATIONS_FUNCTION: INTEGRATIONS_API_FUNCTION_BASE_NAME,
  FEEDBACK_EDIT_FUNCTION: FEEDBACK_EDIT_API_FUNCTION_BASE_NAME,
};

export interface PlanStepProps {
  uniqueName: (baseName: string) => string;
  kmsKey: kms.IKey;
  aggregatesTable: dynamodb.ITable;
  /** Read by think steps' search_feedback. */
  feedbackTable: dynamodb.ITable;
}

export function createPlanStepFunction(scope: Construct, props: PlanStepProps): NodejsFunction {
  const { uniqueName, kmsKey, aggregatesTable, feedbackTable } = props;
  const functionName = uniqueName(PLAN_STEP_FUNCTION_BASE_NAME);
  const role = workerRole(scope, 'PlanStepRole');
  aggregatesTable.grant(role, 'dynamodb:GetItem', 'dynamodb:Query');
  feedbackTable.grantReadData(role);
  kmsKey.grantDecrypt(role);
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'BedrockInvoke',
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: stackModelArns(cdk.Stack.of(scope)),
  }));
  const delegates = Object.fromEntries(
    Object.entries(PLAN_STEP_DELEGATES).map(([env, base]) => [env, uniqueName(base)]),
  );
  grantInvokeByName(cdk.Stack.of(scope), role, Object.values(delegates), 'InvokeDomainApis');

  const fn = new NodejsFunction(scope, 'PlanStep', {
    functionName,
    entry: path.join(STREAM_ROOT, 'src/plan-step/handler.ts'),
    depsLockFilePath: path.join(STREAM_ROOT, 'package-lock.json'),
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    role,
    // Like the streaming assistant: a think step is a bounded tool loop.
    memorySize: 1024,
    timeout: cdk.Duration.seconds(300),
    // A Step Functions task: the state machine decides about retries, never a hidden re-drive.
    retryAttempts: 0,
    environment: {
      ...delegates,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      FEEDBACK_TABLE: feedbackTable.tableName,
      // agent_worker surface default when no override is set (mirrors model_config.py).
      BEDROCK_MODEL_ID: 'global.anthropic.claude-sonnet-5-5',
    },
    bundling: {
      format: OutputFormat.ESM,
      mainFields: ['module', 'main'],
      externalModules: ['@aws-sdk/*', '@smithy/*'],
      // The assistant's list (api-assistant-lambdas.ts ChatStreamApi): the catalogue it reuses
      // imports the same clients (web-search signing, canonical reads, the URL-signing key).
      nodeModules: [
        '@aws-sdk/credential-provider-node',
        '@aws-sdk/client-lambda',
        '@smithy/protocol-http',
        '@smithy/signature-v4',
        '@aws-sdk/client-secrets-manager',
      ],
    },
    logGroup: new logs.LogGroup(scope, 'PlanStepLogs', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });
  NagSuppressions.addResourceSuppressions(fn, [
    { id: 'AwsSolutions-L1', reason: 'Node.js 22 is the target runtime for the stream-built Lambdas — latest stable LTS' },
  ], true);
  return fn;
}
