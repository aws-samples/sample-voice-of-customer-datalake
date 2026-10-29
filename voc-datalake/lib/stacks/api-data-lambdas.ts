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
import { loadPlugins, aggregateSecretsByPlugin, getEnabledPlugins, getPluginsWithIngestor, type PluginManifest } from '../plugin-loader';
import { serviceQuotasReadSuppressions } from '../utils/nag-suppressions';
import { stackModelArns } from '../utils/model-allowlist';
import { SOURCE_PLACEHOLDER } from '../utils/naming';
import {
  FEEDBACK_EDIT_API_FUNCTION_BASE_NAME, INTEGRATIONS_API_FUNCTION_BASE_NAME, METRICS_API_FUNCTION_BASE_NAME,
  DESIGN_CAPTURE_FUNCTION_BASE_NAME, RETENTION_FUNCTION_BASE_NAME, SCRAPERS_API_FUNCTION_BASE_NAME, SETTINGS_API_FUNCTION_BASE_NAME,
} from '../utils/function-names';
import { snapStartFunctionProps } from '../utils/snapstart';
import { PII_REDACTION_ENV, piiDetectionStatement } from '../utils/pii-redaction';
import { CATEGORY_REPROCESS_FUNCTION_BASE_NAME } from './processing-stack-consolidated';
import {
  ASSIST_JOB_TABLE_ACTIONS, ASSIST_WORKER_ENV, SCRAPERS_ASSIST_FUNCTION_BASE_NAME, SETTINGS_ASSIST_FUNCTION_BASE_NAME,
  assistWorkerName, createAssistWorker, functionArnByName, grantAssistWorkerInvoke,
} from './api-assist-workers';
import type { ApiStackContext } from './api-context';
import { AGGREGATES_VERSION_PARTITION, grantCacheVersionBump } from '../utils/cache-version-grants';
import { briefingApiWiring } from './briefing-worker';
import { grantImageModelProbe } from './api-marketplace';
import { LOGO_PREVIEW_PREFIX } from './design-capture';
import { INBOUND_EMAIL_RULE_BASE_NAME, inboundEmailSettingsEnv } from '../utils/inbound-email';

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
    feedbackTable, aggregatesTable, jobsTable, kmsKey, rawDataBucket, processingQueueUrl, processingQueueArn,
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
    // Power Tuning 2026-10-06 pinned 1024; superseded 2026-10-18 (83.1 % p95 at 1024 MB → 1536); doubled
    // 2026-10-20 (74.9 % p95 at 1536 MB, lib/sizing/policy.ts)
    memorySize: 1769, // one vCPU 2026-10-23: single-threaded Python gains nothing above it (lib/sizing/policy.ts)
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
  // The data_version bump after an edit (read-your-write for the read cache, docs/caching.md).
  grantCacheVersionBump(aggregatesTable, feedbackEditRole, AGGREGATES_VERSION_PARTITION);
  kmsKey.grantEncryptDecrypt(feedbackEditRole);

  const feedbackEditLambda = new lambda.Function(stack, 'FeedbackEditApi', {
    functionName: ctx.uniqueName(FEEDBACK_EDIT_API_FUNCTION_BASE_NAME),
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
  const enabledPlugins = getEnabledPlugins(allPlugins, ctx.props.enabledSources);
  const enabledSourcesEnv = JSON.stringify(enabledPlugins.map((p) => p.id));

  const integrationsRole = ctx.role('IntegrationsLambdaRole');
  integrationsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
    resources: [secretsArn],
  }));
  // The enable/disable routes and GET /sources/status toggle and describe a
  // per-plugin schedule rule: grant exactly the rules VocIngestionStack creates
  // (every enabled plugin whose ingestor declares a schedule), by their resolved
  // names — no wildcard, so a disabled plugin's or another deployment's rule is
  // unreachable. DescribeRule on a source without a rule is AccessDenied, which
  // the handler reads as "not scheduled".
  const scheduleRuleArns = getPluginsWithIngestor(enabledPlugins)
    .filter((plugin) => Boolean(plugin.infrastructure.ingestor?.schedule))
    .map((plugin) => stack.formatArn({
      service: 'events',
      resource: 'rule',
      resourceName: ctx.uniqueName(`voc-ingest-${plugin.id}-schedule`),
    }));
  if (scheduleRuleArns.length > 0) {
    integrationsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:EnableRule', 'events:DisableRule', 'events:DescribeRule'],
      resources: scheduleRuleArns,
    }));
  }
  // POST /sources/{source}/run invokes a per-plugin ingestor: grant exactly the
  // ingestors VocIngestionStack creates (every enabled plugin with an ingestor),
  // by their resolved names — no wildcard, so a disabled plugin's or another
  // deployment's function is unreachable (#234).
  const ingestorArns = getPluginsWithIngestor(enabledPlugins)
    .map((plugin) => functionArnByName(ctx, ctx.uniqueName(`voc-ingestor-${plugin.id}`)));
  if (ingestorArns.length > 0) {
    integrationsRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: ingestorArns }));
  }

  const integrationsLambda = new lambda.Function(stack, 'IntegrationsApi', {
    ...snapStartFunctionProps(), // GET /sources/status cold start (lib/utils/snapstart.ts)
    functionName: ctx.uniqueName(INTEGRATIONS_API_FUNCTION_BASE_NAME),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'integrations_handler.lambda_handler',
    code: createApiLambdaCode('integrations_handler.py'),
    role: integrationsRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 1769, // one vCPU 2026-10-23: single-threaded Python gains nothing above it (lib/sizing/policy.ts)
    // POST /sources/{source}/run and the enable/disable routes address a
    // PER-PLUGIN ingestor and schedule rule, so one fixed name will not do.
    // With no prefix the handler derives `{base}-{DEPLOY_ACCOUNT_ID}-{DEPLOY_REGION}`,
    // which is exactly uniqueName(); under a prefix that derivation would name a
    // function that does not exist (a ResourceNotFound the user experiences as
    // "the scraper runs but pulls no reviews"), so CDK hands down the resolved
    // PATTERNS instead, as it hands WEBSCRAPER_FUNCTION_NAME to the scrapers API.
    // Only on a prefixed deployment, so the default template stays as it was
    // (VocStack.prefixOnlyEnv).
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
  // POST /scrapers/{id}/run invokes the webscraper ingestor by its exact name
  // (the same string handed down as WEBSCRAPER_FUNCTION_NAME).
  const webscraperFunctionName = ctx.uniqueName('voc-ingestor-webscraper');
  scrapersRole.addToPolicy(new iam.PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [functionArnByName(ctx, webscraperFunctionName)],
  }));
  scrapersRole.addToPolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: stackModelArns(stack),
  }));
  // No Marketplace grant: the scrapers API invokes only allowlisted TEXT models,
  // never the Marketplace-listed image model (lib/stacks/api-marketplace.ts).

  // Assist jobs (POST /scrapers/analyze-url): the job row in the jobs table
  // (shared/assist_jobs.py — put, consistent get, conditional update only) and
  // the 15-minute twin that runs the model call.
  jobsTable.grant(scrapersRole, ...ASSIST_JOB_TABLE_ACTIONS);
  const scrapersWorkerName = assistWorkerName(ctx, SCRAPERS_ASSIST_FUNCTION_BASE_NAME);
  grantAssistWorkerInvoke(ctx, scrapersRole, scrapersWorkerName);

  const scrapersProps: lambda.FunctionProps = {
    functionName: ctx.uniqueName(SCRAPERS_API_FUNCTION_BASE_NAME),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'scrapers_handler.lambda_handler',
    code: createApiLambdaCode('scrapers_handler.py'),
    role: scrapersRole,
    // 120s headroom for large CSV uploads (batched SQS sends). The API
    // Gateway 29s integration limit is the real ceiling on sync uploads;
    // this just keeps the Lambda from dying before that.
    timeout: cdk.Duration.seconds(120),
    memorySize: 1536, // CPU-bound: memory buys vCPU; keep CPU <= 60% of the share
    environment: { SECRETS_ARN: secretsArn, AGGREGATES_TABLE: aggregatesTable.tableName, WEBSCRAPER_FUNCTION_NAME: webscraperFunctionName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-scrapers-api', LOG_LEVEL: 'INFO', JOBS_TABLE: jobsTable.tableName, [ASSIST_WORKER_ENV]: scrapersWorkerName },
    layers: [apiLayer],
    logGroup: ctx.logGroup('ScrapersApiLogs', ctx.uniqueName('voc-scrapers-api')),
  };
  const scrapersLambda = new lambda.Function(stack, 'ScrapersApi', scrapersProps);
  // The twin keeps its own size: the 2026-10-18 raise was measured on the REST path (lib/sizing/policy.ts).
  createAssistWorker(ctx, 'ScrapersAssistWorker', { baseName: SCRAPERS_ASSIST_FUNCTION_BASE_NAME, apiProps: scrapersProps, memorySize: 1024 });


  // Manual Import API
  const manualImportRole = ctx.role('ManualImportLambdaRole');
  aggregatesTable.grantReadWriteData(manualImportRole);
  kmsKey.grantEncryptDecrypt(manualImportRole);
  manualImportRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));
  // The async processor is invoked by its exact name (MANUAL_IMPORT_PROCESSOR_FUNCTION).
  const manualImportProcessorName = ctx.uniqueName('voc-manual-import-processor');
  manualImportRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [functionArnByName(ctx, manualImportProcessorName)] }));
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
    memorySize: 1024, // CPU-bound: memory buys vCPU; keep CPU <= 60% of the share
    environment: {
      AGGREGATES_TABLE: aggregatesTable.tableName,
      PROCESSING_QUEUE_URL: processingQueueUrl,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      MANUAL_IMPORT_PROCESSOR_FUNCTION: manualImportProcessorName,
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
    functionName: manualImportProcessorName,
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
  // ... and assist jobs plus the design-reference refresh run on the settings
  // assist twin (settings_handler: ASSIST_WORKER_FUNCTION). The API function no
  // longer invokes itself. Every ARN is built by name: grantInvoke() on a
  // function sharing this role would make the role depend on the function that
  // depends on the role.
  const settingsFunctionName = ctx.uniqueName(SETTINGS_API_FUNCTION_BASE_NAME);
  // Live-website design references are read by voc-design-capture (VocIngestionStack, deployed first).
  const designCaptureFunctionName = ctx.uniqueName(DESIGN_CAPTURE_FUNCTION_BASE_NAME);
  const settingsWorkerName = assistWorkerName(ctx, SETTINGS_ASSIST_FUNCTION_BASE_NAME);
  settingsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [categoryReprocessFunctionName, retentionFunctionName, settingsWorkerName, designCaptureFunctionName]
      .map((resourceName) => functionArnByName(ctx, resourceName)),
  }));
  // Assist jobs (category generation):
  // the job row in the jobs table (shared/assist_jobs.py).
  jobsTable.grant(settingsRole, ...ASSIST_JOB_TABLE_ACTIONS);
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
  // A stored reading is refreshed quota by quota (shared/model_quota_store.py): read-only, Bedrock quotas only.
  settingsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['servicequotas:GetServiceQuota'],
    resources: [`arn:${cdk.Aws.PARTITION}:servicequotas:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:bedrock/*`],
  }));
  NagSuppressions.addResourceSuppressions(settingsRole, serviceQuotasReadSuppressions, true);
  // Administration → AI models → Image generation: test call, access status, Marketplace (api-marketplace.ts).
  grantImageModelProbe(settingsRole);
  // Design system (docs/company-context.md): the Figma/GitHub tokens are
  // written by PUT /settings/design-system/integrations and read only by the
  // reference refresh — never returned to a caller. Explicit statement, not
  // grantRead(): same KMS key-policy cycle as the CDN signing secret.
  settingsRole.addToPolicy(new iam.PolicyStatement({
    actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
    resources: [designIntegrationsSecretArn],
  }));
  // Design-system uploads (screenshots/HTML via presigned PUT, the logo) under
  // company-context/ only. Read + put; removing a reference archives it and keeps
  // the uploaded object (keep-all) — only its logo preview is deleted (below).
  rawDataBucket.grantRead(settingsRole, 'company-context/*');
  rawDataBucket.grantPut(settingsRole, 'company-context/*');
  // The ONE delete: archiving a reference removes its logo PREVIEW (a copy made when the reference was
  // read, shared/design_logo.py delete_previews). Exactly s3:DeleteObject, on the preview keys only.
  settingsRole.addToPolicy(new iam.PolicyStatement({
    sid: 'DeleteLogoPreviewOnArchive',
    actions: ['s3:DeleteObject'],
    resources: [rawDataBucket.arnForObjects(`${LOGO_PREVIEW_PREFIX}*`)],
  }));
  // The morning brief (docs/briefing.md): Refresh queues, the caller's own email subscription.
  const briefing = briefingApiWiring(stack, ctx.uniqueName, kmsKey, ctx.props.userPool);
  briefing.grant(settingsRole);

  const settingsProps: lambda.FunctionProps = {
    functionName: settingsFunctionName,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'settings_handler.lambda_handler',
    code: createApiLambdaCode('settings_handler.py'),
    role: settingsRole,
    timeout: cdk.Duration.seconds(30),
    // Power Tuning 2026-10-06 pinned 512; superseded 2026-10-18 (96.4 % p95 at 512 MB, lib/sizing/policy.ts)
    memorySize: 1024, // CPU-bound: memory buys vCPU; keep CPU <= 60% of the share
    environment: {
      AGGREGATES_TABLE: aggregatesTable.tableName,
      // The category reprocess worker lives in VocProcessingStack. Named, not
      // imported: the deterministic physical name needs no cross-stack export,
      // and this stack already deploys after Processing.
      CATEGORY_REPROCESS_FUNCTION: categoryReprocessFunctionName,
      RETENTION_FUNCTION: retentionFunctionName,
      DESIGN_CAPTURE_FUNCTION: designCaptureFunctionName,
      DESIGN_INTEGRATIONS_SECRET_ARN: designIntegrationsSecretArn,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: 'voc-settings-api',
      LOG_LEVEL: 'INFO',
      JOBS_TABLE: jobsTable.tableName,
      [ASSIST_WORKER_ENV]: settingsWorkerName,
      ...briefing.environment,
      // Settings → Email inbox (docs/email-intake.md); nothing when the inbox is off.
      ...inboundEmailSettingsEnv(stack.node, () => ctx.uniqueName(INBOUND_EMAIL_RULE_BASE_NAME)),
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('SettingsApiLogs', ctx.uniqueName('voc-settings-api')),
  };
  const settingsLambda = new lambda.Function(stack, 'SettingsApi', settingsProps);
  // The twin keeps its own size: the 2026-10-18 raise was measured on the REST path (lib/sizing/policy.ts).
  createAssistWorker(ctx, 'SettingsAssistWorker', { baseName: SETTINGS_ASSIST_FUNCTION_BASE_NAME, apiProps: settingsProps, memorySize: 512 });

  return {
    allPlugins, enabledSourcesEnv, metricsLambda, feedbackEditLambda, integrationsLambda, scrapersLambda, manualImportLambda, settingsLambda,
  };
}
