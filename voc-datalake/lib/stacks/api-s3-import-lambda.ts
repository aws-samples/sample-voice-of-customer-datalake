/**
 * VocApiStack's S3 import API (`voc-s3-import-api`, lambda/api/s3_import_handler.py):
 * the admin-only explorer over VocIngestionStack's import bucket. Resources are
 * created on the stack itself (logical ids unchanged) — see api-context.ts.
 *
 * `POST /s3-import/reprocess` (issue #144, docs/data-lake-structure.md) re-runs one file
 * through the `s3_import` ingestor, reached BY NAME like every ingestor the API
 * invokes (`POST /sources/{source}/run`, api-data-lambdas.ts): VocIngestionStack
 * deploys first, and a construct reference would add a cross-stack export.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { getPluginsWithIngestor, type PluginManifest } from '../plugin-loader';
import { ingestorFunctionBaseName } from './dlq-alarms';
import { functionArnByName } from './api-assist-workers';
import type { ApiStackContext } from './api-context';

const S3_IMPORT_PLUGIN_ID = 's3_import';
/** The reprocess run rows (`SOURCE_RUN#s3_import` / `<run id>`, lambda/shared/s3_import_runs.py SOURCE_RUN_PK). */
export const S3_IMPORT_RUN_PARTITION = `SOURCE_RUN#${S3_IMPORT_PLUGIN_ID}`;

/** Whether VocIngestionStack creates the s3_import ingestor in this deployment (plugin enabled, ingestor on). */
export function s3ImportIngestorDeployed(enabledPlugins: readonly PluginManifest[]): boolean {
  return getPluginsWithIngestor([...enabledPlugins]).some((plugin) => plugin.id === S3_IMPORT_PLUGIN_ID);
}

/**
 * The reprocess grants: invoke exactly the s3_import ingestor (unqualified ARN by
 * name), and Put/Get/Update on the aggregates table pinned by `dynamodb:LeadingKeys`
 * to the run partition, so the role can write nothing else there. Returns the env
 * the handler reads, empty when the ingestor is not deployed (the route then
 * answers "not configured").
 */
function grantReprocess(ctx: ApiStackContext, role: iam.Role, ingestorDeployed: boolean): Record<string, string> {
  if (!ingestorDeployed) return {};
  const ingestorName = ctx.uniqueName(ingestorFunctionBaseName(S3_IMPORT_PLUGIN_ID));
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [functionArnByName(ctx, ingestorName)],
  }));
  const { aggregatesTable } = ctx.props;
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
    resources: [aggregatesTable.tableArn],
    conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [S3_IMPORT_RUN_PARTITION] } },
  }));
  return { S3_IMPORT_INGESTOR_FUNCTION: ingestorName, AGGREGATES_TABLE: aggregatesTable.tableName };
}

/** *ingestorDeployed*: `s3ImportIngestorDeployed` of the stack's enabled plugins (loaded once, in api-data-lambdas.ts). */
export function createS3ImportLambda(ctx: ApiStackContext, ingestorDeployed: boolean): lambda.Function {
  const { stack, allowedOrigin, apiLayer, apiCode: createApiLambdaCode } = ctx;
  const { kmsKey, s3ImportBucket } = ctx.props;

  const s3ImportRole = ctx.role('S3ImportLambdaRole');
  s3ImportBucket.grantReadWrite(s3ImportRole);
  // Also the aggregates table's CMK for the run rows.
  kmsKey.grantEncryptDecrypt(s3ImportRole);
  const reprocessEnv = grantReprocess(ctx, s3ImportRole, ingestorDeployed);

  return new lambda.Function(stack, 'S3ImportApi', {
    functionName: ctx.uniqueName('voc-s3-import-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 's3_import_handler.lambda_handler',
    code: createApiLambdaCode('s3_import_handler.py'),
    role: s3ImportRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 1024, // CPU-bound: memory buys vCPU; keep CPU <= 60% of the share
    environment: {
      S3_IMPORT_BUCKET: s3ImportBucket.bucketName, ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: 'voc-s3-import-api', LOG_LEVEL: 'INFO', ...reprocessEnv,
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('S3ImportApiLogs', ctx.uniqueName('voc-s3-import-api')),
  });
}
