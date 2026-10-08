/**
 * VocApiStack's data and configuration API Lambdas: metrics, feedback edit,
 * integrations, scrapers, manual import (+ its async processor) and settings.
 * Resources are created on the stack itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';
import { loadPlugins, aggregateSecretsByPlugin, getEnabledPlugins, type PluginManifest } from '../plugin-loader';
import { pluginSystemSuppressions, serviceQuotasReadSuppressions } from '../utils/nag-suppressions';
import { stackModelArns } from '../utils/model-allowlist';
import { SOURCE_PLACEHOLDER } from '../utils/naming';
import { METRICS_API_FUNCTION_BASE_NAME, RETENTION_FUNCTION_BASE_NAME } from '../utils/function-names';
import { snapStartFunctionProps } from '../utils/snapstart';
import { PII_REDACTION_ENV, piiDetectionStatement } from '../utils/pii-redaction';
import { CATEGORY_REPROCESS_FUNCTION_BASE_NAME } from './processing-stack-consolidated';
import type { ApiStackContext } from './api-context';

export interface DataLambdas {
  /** Every plugin manifest on disk (enabled or not) — the webhooks read the enabled subset. */
  allPlugins: PluginManifest[];
  /**
   * The ENABLED_SOURCES env value: a JSON array of the ids of the plugins that
   * are enabled in `pluginStatus` AND present under `plugins/`. The integrations
   * and logs handlers fan out over it (plus `manual_import`) when a request
   * names no source — `lambda/shared/enabled_sources.py`, issue #256.
   */
  enabledSourcesEnv: string;
  metricsLambda: lambda.Function;
  feedbackEditLambda: lambda.Function;
  integrationsLambda: lambda.Function;
  scrapersLambda: lambda.Function;
  manualImportLambda: lambda.Function;
  settingsLambda: lambda.Function;
}

export function createDataLambdas(ctx: ApiStackContext): DataLambdas {
  const { stack, allowedOrigin, apiLayer, apiCode: createApiLambdaCode } = ctx;
  const {
    feedbackTable, aggregatesTable, kmsKey, rawDataBucket, processingQueueUrl, processingQueueArn,
    secretsArn, designIntegrationsSecretArn,
  } = ctx.props;

  // Metrics API
  const metricsRole = ctx.role('MetricsLambdaRole');
  feedbackTable.grantReadData(metricsRole);
  aggregatesTable.grantReadWriteData(metricsRole);
  kmsKey.grantEncryptDecrypt(metricsRole);

  const metricsLambda = new lambda.Function(stack, 'MetricsApi', {
    functionName: ctx.uniqueName(METRICS_API_FUNCTION_BASE_NAME),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'metrics_handler.lambda_handler',
    code: createApiLambdaCode('metrics_handler.py'),
    role: metricsRole,
    timeout: cdk.Duration.seconds(30),
    // Power Tuning 2026-10-06, balanced, see voc-e2e/verify/power-tuning (lib/sizing/policy.ts)
    memorySize: 1024, // CPU-bound: memory buys vCPU; keep CPU <= 70% of the share
    environment: {
      FEEDBACK_TABLE: feedbackTable.tableName,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: 'voc-metrics-api',
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('MetricsApiLogs', ctx.uniqueName(METRICS_API_FUNCTION_BASE_NAME)),
  });

  // Feedback Edit API — PUT /feedback/{id}/category (manual category
  // correction, from the UI or the assistant's approval-gated tool). Its own
  // Lambda so the feedback-table WRITE stays off every read path: the metrics
  // role above holds read-only access to feedback. Exactly the item actions
  // the handler calls — resolve by id (Query on gsi4-by-feedback-id), re-read
  // (GetItem), conditional in-place update (UpdateItem); never Put/Delete.
  // Aggregates read: the categories config and the caller's CATEGORY_ACCESS row.
  const feedbackEditRole = ctx.role('FeedbackEditLambdaRole');
  feedbackTable.grant(feedbackEditRole, 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem');
  aggregatesTable.grant(feedbackEditRole, 'dynamodb:GetItem', 'dynamodb:Query');
  kmsKey.grantEncryptDecrypt(feedbackEditRole);

  const feedbackEditLambda = new lambda.Function(stack, 'FeedbackEditApi', {
    functionName: ctx.uniqueName('voc-feedback-edit-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'feedback_edit_handler.lambda_handler',
    code: createApiLambdaCode('feedback_edit_handler.py'),
    role: feedbackEditRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 256,
    environment: {
      FEEDBACK_TABLE: feedbackTable.tableName,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: 'voc-feedback-edit-api',
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('FeedbackEditApiLogs', ctx.uniqueName('voc-feedback-edit-api')),
  });

  // Integrations API
  //
  // The plugin manifests are read here, at synth time, and the SECRET DEFAULTS
  // they declare are handed to the integrations handler as one env var. That
  // handler needs them for two things it cannot otherwise know: which sources
  // exist, and which stored values a human actually entered rather than
  // inherited from the deploy. `allPlugins`, not the enabled subset — this must
  // mirror what ingestion-stack's createApiSecrets() actually seeded, and that
  // seeds every plugin regardless of pluginStatus.
  const pluginsDir = path.join(__dirname, '../../plugins');
  const allPlugins = loadPlugins(pluginsDir);
  const pluginSecretDefaults = aggregateSecretsByPlugin(allPlugins);
  const enabledSourcesEnv = JSON.stringify(getEnabledPlugins(allPlugins, ctx.props.enabledSources).map((p) => p.id));

  const integrationsRole = ctx.role('IntegrationsLambdaRole');
  integrationsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
    resources: [secretsArn],
  }));
  // Prefixed so the wildcards cannot reach into a SECOND deployment's
  // ingestors in the same account and region. The trailing `*` stays: it
  // stands in for the `-<account>-<region>` suffix, and narrowing these to
  // exact names is issue #234, deliberately a separate change.
  integrationsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['events:EnableRule', 'events:DisableRule', 'events:DescribeRule'],
    resources: [`arn:aws:events:${stack.region}:${stack.account}:rule/${ctx.prefixed('voc-ingest')}-*-schedule*`],
  }));
  integrationsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:${ctx.prefixed('voc-ingestor')}-*`],
  }));
  NagSuppressions.addResourceSuppressions(integrationsRole, pluginSystemSuppressions(ctx.deploymentPrefix), true);

  const integrationsLambda = new lambda.Function(stack, 'IntegrationsApi', {
    ...snapStartFunctionProps(), // GET /sources/status cold start (lib/utils/snapstart.ts)
    functionName: ctx.uniqueName('voc-integrations-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'integrations_handler.lambda_handler',
    code: createApiLambdaCode('integrations_handler.py'),
    role: integrationsRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 1024, // CPU-bound: 512 MB breached 70 % (3.00.00 capacity, lib/sizing/policy.ts)
    // POST /sources/{source}/run and the enable/disable routes address a
    // PER-PLUGIN ingestor and schedule rule, so one fixed name will not do —
    // but resolving the pattern is still the infrastructure's job, not the
    // handler's, exactly as WEBSCRAPER_FUNCTION_NAME and
    // MANUAL_IMPORT_PROCESSOR_FUNCTION are already handed down. Rebuilding
    // the name in Python from DEPLOY_ACCOUNT_ID/DEPLOY_REGION would, under a
    // prefix, invoke a function that does not exist — a ResourceNotFound the
    // user experiences as "the scraper runs but pulls no reviews".
    environment: { SECRETS_ARN: secretsArn, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-integrations-api', LOG_LEVEL: 'INFO', DEPLOY_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID, DEPLOY_REGION: cdk.Aws.REGION, PLUGIN_SECRET_DEFAULTS: JSON.stringify(pluginSecretDefaults), ENABLED_SOURCES: enabledSourcesEnv, ...ctx.prefixOnlyEnv({
      INGESTOR_FUNCTION_NAME_PATTERN: ctx.uniqueNamePattern(`voc-ingestor-${SOURCE_PLACEHOLDER}`),
      INGEST_SCHEDULE_RULE_NAME_PATTERN: ctx.uniqueNamePattern(`voc-ingest-${SOURCE_PLACEHOLDER}-schedule`),
    }), AGGREGATES_TABLE: aggregatesTable.tableName },
    layers: [apiLayer],
    logGroup: ctx.logGroup('IntegrationsApiLogs', ctx.uniqueName('voc-integrations-api')),
  });
  aggregatesTable.grantReadWriteData(integrationsRole);

  // Scrapers API
  const scrapersRole = ctx.role('ScrapersLambdaRole');
  aggregatesTable.grantReadWriteData(scrapersRole);
  kmsKey.grantEncryptDecrypt(scrapersRole);
  scrapersRole.addToPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
    resources: [secretsArn],
  }));
  scrapersRole.addToPolicy(new iam.PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:${ctx.prefixed('voc-ingestor-webscraper')}-*`],
  }));
  NagSuppressions.addResourceSuppressions(scrapersRole, pluginSystemSuppressions(ctx.deploymentPrefix), true);
  scrapersRole.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: stackModelArns(stack),
  }));
  // No Marketplace grant: the scrapers API invokes only allowlisted TEXT models,
  // never the Marketplace-listed image model (lib/stacks/api-marketplace.ts).

  const scrapersLambda = new lambda.Function(stack, 'ScrapersApi', {
    functionName: ctx.uniqueName('voc-scrapers-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'scrapers_handler.lambda_handler',
    code: createApiLambdaCode('scrapers_handler.py'),
    role: scrapersRole,
    // 120s headroom for large CSV uploads (batched SQS sends). The API
    // Gateway 29s integration limit is the real ceiling on sync uploads;
    // this just keeps the Lambda from dying before that.
    timeout: cdk.Duration.seconds(120),
    memorySize: 1024, // CPU-bound: memory buys vCPU; keep CPU <= 70% of the share
    environment: { SECRETS_ARN: secretsArn, AGGREGATES_TABLE: aggregatesTable.tableName, WEBSCRAPER_FUNCTION_NAME: ctx.uniqueName('voc-ingestor-webscraper'), ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-scrapers-api', LOG_LEVEL: 'INFO' },
    layers: [apiLayer],
    logGroup: ctx.logGroup('ScrapersApiLogs', ctx.uniqueName('voc-scrapers-api')),
  });


  // Manual Import API
  const manualImportRole = ctx.role('ManualImportLambdaRole');
  aggregatesTable.grantReadWriteData(manualImportRole);
  kmsKey.grantEncryptDecrypt(manualImportRole);
  manualImportRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));
  manualImportRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:${ctx.prefixed('voc-manual-import-processor')}-*`] }));
  NagSuppressions.addResourceSuppressions(manualImportRole, pluginSystemSuppressions(ctx.deploymentPrefix), true);
  rawDataBucket.grantReadWrite(manualImportRole);
  // CSV/JSON/confirm apply the source's PII policy before archive + queue.
  manualImportRole.addToPolicy(piiDetectionStatement());

  const manualImportLambda = new lambda.Function(stack, 'ManualImportApi', {
    functionName: ctx.uniqueName('voc-manual-import-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'manual_import_handler.lambda_handler',
    code: createApiLambdaCode('manual_import_handler.py'),
    role: manualImportRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 512, // CPU-bound: memory buys vCPU; keep CPU <= 70% of the share
    environment: {
      AGGREGATES_TABLE: aggregatesTable.tableName,
      PROCESSING_QUEUE_URL: processingQueueUrl,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      MANUAL_IMPORT_PROCESSOR_FUNCTION: ctx.uniqueName('voc-manual-import-processor'),
      ...PII_REDACTION_ENV,
      ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: 'voc-manual-import-api',
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('ManualImportApiLogs', ctx.uniqueName('voc-manual-import-api')),
  });

  // Manual Import Processor (async)
  const manualImportProcessorRole = ctx.role('ManualImportProcessorRole');
  aggregatesTable.grantReadWriteData(manualImportProcessorRole);
  kmsKey.grantEncryptDecrypt(manualImportProcessorRole);
  manualImportProcessorRole.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: stackModelArns(stack),
  }));

  new lambda.Function(stack, 'ManualImportProcessor', {
    functionName: ctx.uniqueName('voc-manual-import-processor'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'manual_import_processor.lambda_handler',
    code: createApiLambdaCode('manual_import_processor.py'),
    role: manualImportProcessorRole,
    timeout: cdk.Duration.minutes(5),
    memorySize: 1024,
    // Default async retries kept (bounded, idempotent work); only the
    // exhausted invocation is recorded (#253, ctx.asyncFailureDestination).
    onFailure: ctx.asyncFailureDestination,
    environment: { AGGREGATES_TABLE: aggregatesTable.tableName, POWERTOOLS_SERVICE_NAME: 'voc-manual-import-processor', LOG_LEVEL: 'INFO' },
    layers: [apiLayer],
    logGroup: ctx.logGroup('ManualImportProcessorLogs', ctx.uniqueName('voc-manual-import-processor')),
  });

  // Settings API
  const settingsRole = ctx.role('SettingsLambdaRole');
  aggregatesTable.grantReadWriteData(settingsRole);
  kmsKey.grantEncryptDecrypt(settingsRole);
  // POST /settings/categories/reprocess starts the worker asynchronously.
  const categoryReprocessFunctionName = ctx.uniqueName(CATEGORY_REPROCESS_FUNCTION_BASE_NAME);
  // POST /settings/erasure starts an erasure job on the retention worker
  // (VocProcessingStack) the same way: async invoke by deterministic name.
  const retentionFunctionName = ctx.uniqueName(RETENTION_FUNCTION_BASE_NAME);
  // ... and a design-reference refresh re-invokes ITSELF asynchronously
  // (settings_handler design_reference_refresh). Both ARNs are built by name:
  // grantInvoke() on its own function would make the role depend on the
  // function that depends on the role.
  const settingsFunctionName = ctx.uniqueName('voc-settings-api');
  settingsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [categoryReprocessFunctionName, retentionFunctionName, settingsFunctionName].map((resourceName) => stack.formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    })),
  }));
  settingsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: stackModelArns(stack),
  }));
  // POST /settings/model/test and GET /settings/model/capacity read the account's
  // Bedrock tokens-per-minute quotas (shared/model_capacity.py). Read-only, and
  // ListServiceQuotas supports no resource-level permission, hence `*`.
  settingsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['servicequotas:ListServiceQuotas'],
    resources: ['*'],
  }));
  NagSuppressions.addResourceSuppressions(settingsRole, serviceQuotasReadSuppressions, true);
  // Design system (docs/company-context.md): the Figma/GitHub tokens are
  // written by PUT /settings/design-system/integrations and read only by the
  // reference refresh — never returned to a caller. Explicit statement, not
  // grantRead(): same KMS key-policy cycle as the CDN signing secret.
  settingsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
    resources: [designIntegrationsSecretArn],
  }));
  // Design-system uploads (screenshots/HTML via presigned PUT, the logo) under
  // company-context/ only. Read + put, NO delete: removing a reference archives
  // it and keeps the object (keep-all).
  rawDataBucket.grantRead(settingsRole, 'company-context/*');
  rawDataBucket.grantPut(settingsRole, 'company-context/*');

  const settingsLambda = new lambda.Function(stack, 'SettingsApi', {
    functionName: settingsFunctionName,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'settings_handler.lambda_handler',
    code: createApiLambdaCode('settings_handler.py'),
    role: settingsRole,
    timeout: cdk.Duration.seconds(30),
    // Power Tuning 2026-10-06, balanced, see voc-e2e/verify/power-tuning (lib/sizing/policy.ts)
    memorySize: 512, // CPU-bound: memory buys vCPU; keep CPU <= 70% of the share
    environment: {
      AGGREGATES_TABLE: aggregatesTable.tableName,
      // The category reprocess worker lives in VocProcessingStack. Named, not
      // imported: the deterministic physical name needs no cross-stack export,
      // and this stack already deploys after Processing.
      CATEGORY_REPROCESS_FUNCTION: categoryReprocessFunctionName,
      RETENTION_FUNCTION: retentionFunctionName,
      DESIGN_INTEGRATIONS_SECRET_ARN: designIntegrationsSecretArn,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: 'voc-settings-api',
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('SettingsApiLogs', ctx.uniqueName('voc-settings-api')),
  });

  return {
    allPlugins, enabledSourcesEnv, metricsLambda, feedbackEditLambda, integrationsLambda, scrapersLambda, manualImportLambda, settingsLambda,
  };
}
