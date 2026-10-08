import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';
import {
  loadPlugins,
  getEnabledPlugins,
  aggregateSecrets,
  getPluginsWithIngestor,
  getPluginsWithS3Trigger,
  capitalize,
  pluginDirectoryIds,
  type PluginManifest,
} from '../plugin-loader';
import { NagSuppressions } from 'cdk-nag';
import { apiSecretsSuppressions } from '../utils/nag-suppressions';
import { pythonLayerCode } from '../utils/python-layer-bundling';
import { rootPluginAssetExcludes } from '../utils/lambda-asset-excludes';
import { PII_REDACTION_ENV } from '../utils/pii-redaction';
import { VocStack, VocStackProps } from '../utils/voc-stack';
import { ALARM_TOPIC_BASE_NAME, addQueueDepthAlarm, importAlarmTopic } from './dlq-alarms';
import { createScheduleDeadLetterQueue } from './ingestion-schedule-dlq';
import { IngestorRoles } from './ingestion-roles';

/**
 * S3-import staging bucket retention. Noncurrent versions are recoverable for a
 * week (a mistaken overwrite/delete noticed after a weekend can still be
 * undone), then purged so versioning never grows storage unboundedly; abandoned
 * multipart parts are dropped after a day (S3 cost best practice).
 */
export const IMPORT_NONCURRENT_VERSION_DAYS = 7;
export const IMPORT_ABORT_MULTIPART_DAYS = 1;

/**
 * Scheduled-ingestion delivery (#253). EventBridge invokes the ingestor
 * asynchronously, so these govern only DELIVERY (throttled or unreachable
 * Lambda), not the ingestor's own errors. An event older than an hour is
 * superseded by later ticks of the same 1–30 minute schedule, and ingestion is
 * watermark-driven, so retrying it longer buys nothing.
 */
export const SCHEDULE_TARGET_RETRY_ATTEMPTS = 2;
export const SCHEDULE_TARGET_MAX_EVENT_AGE = cdk.Duration.hours(1);

/** Enforce SSL/TLS for queue access: deny every SQS action over plain HTTP. */
function denyInsecureTransport(queue: sqs.Queue): void {
  queue.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'DenyInsecureTransport',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['sqs:*'],
    resources: [queue.queueArn],
    conditions: {
      Bool: { 'aws:SecureTransport': 'false' },
    },
  }));
}

export interface VocIngestionStackProps extends VocStackProps {
  watermarksTable: dynamodb.Table;
  aggregatesTable: dynamodb.Table;
  rawDataBucket: s3.Bucket;
  accessLogsBucket: s3.Bucket;
  kmsKey: kms.Key;
  config: {
    brandName: string;
    primaryLanguage: string;
    enabledSources: string[];
  };
  frontendDomain?: string;
}

export class VocIngestionStack extends VocStack {
  public readonly ingestionLambdas: Map<string, lambda.Function> = new Map();
  public readonly processingQueue: sqs.Queue;
  public readonly secretsArn: string;
  public readonly s3ImportBucket: s3.Bucket;

  // Built in the constructor once the grant targets exist (see ingestion-roles.ts).
  private ingestorRoles!: IngestorRoles;

  // Created on first use, so a deployment with no scheduled plugin gets no
  // queue or key it never writes to.
  private scheduleDlq?: sqs.Queue;

  /** The Core-owned operational alarm topic every DLQ depth alarm here notifies (#247). */
  private readonly alarmTopic: sns.ITopic;

  constructor(scope: Construct, id: string, props: VocIngestionStackProps) {
    super(scope, id, props);
    this.alarmTopic = importAlarmTopic(this, 'OpsAlarmTopic', this.uniqueName(ALARM_TOPIC_BASE_NAME));

    const { watermarksTable, aggregatesTable, rawDataBucket, accessLogsBucket, kmsKey, config } = props;



    // Load plugins from manifests
    const pluginsDir = path.join(__dirname, '../../plugins');
    const allPlugins = loadPlugins(pluginsDir);
    const enabledPlugins = getEnabledPlugins(allPlugins, config.enabledSources);

    // CORS allowed origins
    const frontendDomain = props.frontendDomain !== undefined && props.frontendDomain !== ''
      ? props.frontendDomain
      : this.node.tryGetContext('frontendDomain');
    const corsAllowedOrigins = this.buildCorsOrigins(frontendDomain);

    // S3 Import Bucket
    this.s3ImportBucket = this.createS3ImportBucket(kmsKey, accessLogsBucket, corsAllowedOrigins);

    // Secrets for API credentials - aggregated from all plugins
    const apiSecrets = this.createApiSecrets(allPlugins);

    // DLQ and Processing Queue
    const dlq = this.createDLQ(kmsKey);
    this.processingQueue = this.createProcessingQueue(kmsKey, dlq);

    // Ingestor execution roles: shared, or dedicated where a plugin needs Bedrock or a schedule
    this.ingestorRoles = new IngestorRoles(this, {
      watermarksTable, aggregatesTable, processingQueue: this.processingQueue, rawDataBucket, kmsKey, apiSecrets,
    });

    // Common environment variables
    const commonEnv = this.buildCommonEnv(watermarksTable, rawDataBucket, apiSecrets, config);

    // Lambda Layer for common dependencies
    const dependenciesLayer = this.createDependenciesLayer();

    // Create Lambda functions for each enabled plugin with ingestor.
    // Sibling excludes derive from DISK, not the loader (see pluginDirectoryIds).
    const allPluginIds = pluginDirectoryIds(pluginsDir);
    const ingestorPlugins = getPluginsWithIngestor(enabledPlugins);
    for (const plugin of ingestorPlugins) {
      this.createIngestorLambda(
        plugin,
        commonEnv,
        dependenciesLayer,
        aggregatesTable,
        allPluginIds
      );
    }

    // Setup S3 triggers for plugins that need them
    const s3TriggerPlugins = getPluginsWithS3Trigger(enabledPlugins);
    for (const plugin of s3TriggerPlugins) {
      this.setupS3Trigger(plugin);
    }

    // Expose secrets ARN for other stacks
    this.secretsArn = apiSecrets.secretArn;

    // Outputs
    new cdk.CfnOutput(this, 'ApiSecretsArn', { value: apiSecrets.secretArn });
    new cdk.CfnOutput(this, 'ProcessingQueueUrl', { value: this.processingQueue.queueUrl });
    new cdk.CfnOutput(this, 'DLQUrl', { value: dlq.queueUrl });
    new cdk.CfnOutput(this, 'S3ImportBucketName', { value: this.s3ImportBucket.bucketName });
    new cdk.CfnOutput(this, 'S3ImportBucketArn', { value: this.s3ImportBucket.bucketArn });
    new cdk.CfnOutput(this, 'LoadedPlugins', { value: allPlugins.map(p => p.id).join(',') });
    new cdk.CfnOutput(this, 'EnabledPlugins', { value: enabledPlugins.map(p => p.id).join(',') });
  }

  // ============================================
  // Helper Methods
  // ============================================

  private buildCorsOrigins(frontendDomain: string | undefined): string[] {
    const devOrigins = ['http://localhost:5173', 'http://localhost:3000'];
    if (frontendDomain) {
      return [`https://${frontendDomain}`, ...devOrigins];
    }
    return devOrigins;
  }

  private createS3ImportBucket(
    kmsKey: kms.Key,
    accessLogsBucket: s3.Bucket,
    corsAllowedOrigins: string[]
  ): s3.Bucket {
    return new s3.Bucket(this, 'S3ImportBucket', {
      bucketName: this.uniqueDnsName('voc-import'),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Versioned (AWS S3 security best practice: recover from accidental
      // overwrite/delete). Deletes through the API become delete markers, which
      // list_objects_v2 hides, so the UI and ingestor see no difference. The
      // `staging-version-hygiene` rule below keeps the cost of versioning
      // bounded on what is only a staging bucket.
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 's3-import-bucket/',
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.GET],
          allowedOrigins: corsAllowedOrigins,
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          id: 'move-processed-to-glacier',
          prefix: 'processed/',
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(30) },
          ],
        },
        {
          // Retention rationale on IMPORT_NONCURRENT_VERSION_DAYS above; short
          // because once ingested, the durable copy is the raw data lake.
          id: 'staging-version-hygiene',
          noncurrentVersionExpiration: cdk.Duration.days(IMPORT_NONCURRENT_VERSION_DAYS),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(IMPORT_ABORT_MULTIPART_DAYS),
        },
        {
          // Separate rule: S3 rejects ExpiredObjectDeleteMarker alongside other
          // expiration settings. Clears markers left once their versions expire.
          id: 'remove-expired-delete-markers',
          expiredObjectDeleteMarker: true,
        },
      ],
    });
  }

  private createApiSecrets(plugins: PluginManifest[]): secretsmanager.Secret {
    // Aggregate secrets from all plugins
    const pluginSecrets = aggregateSecrets(plugins);

    // Legacy secrets for backward compatibility with non-migrated sources
    const legacySecrets: Record<string, string> = {
      webscraper_configs: '[]',
    };

    const secret = new secretsmanager.Secret(this, 'VocApiSecrets', {
      secretName: this.uniqueName('voc-datalake/api-credentials'),
      description: 'API credentials for VoC data sources',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          ...legacySecrets,
          ...pluginSecrets,
        }),
        generateStringKey: 'placeholder',
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    NagSuppressions.addResourceSuppressions(secret, apiSecretsSuppressions);
    return secret;
  }

  private createDLQ(kmsKey: kms.Key): sqs.Queue {
    const queueName = this.uniqueName('voc-processing-dlq');
    const dlq = new sqs.Queue(this, 'ProcessingDLQ', {
      queueName,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    denyInsecureTransport(dlq);
    addQueueDepthAlarm(this, 'ProcessingDLQDepthAlarm', { queueName, topic: this.alarmTopic });

    return dlq;
  }

  /** The schedule targets' dead-letter queue (#253), created on first use. */
  private scheduleDeadLetterQueue(): sqs.Queue {
    this.scheduleDlq ??= createScheduleDeadLetterQueue(this, {
      queueName: this.uniqueName('voc-ingest-schedule-dlq'),
      alarmTopic: this.alarmTopic,
      denyInsecureTransport,
    });
    return this.scheduleDlq;
  }

  private createProcessingQueue(kmsKey: kms.Key, dlq: sqs.Queue): sqs.Queue {
    const queue = new sqs.Queue(this, 'ProcessingQueue', {
      queueName: this.uniqueName('voc-processing-queue'),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    denyInsecureTransport(queue);

    return queue;
  }

  private buildCommonEnv(
    watermarksTable: dynamodb.Table,
    rawDataBucket: s3.Bucket,
    apiSecrets: secretsmanager.Secret,
    config: VocIngestionStackProps['config']
  ): Record<string, string> {
    return {
      WATERMARKS_TABLE: watermarksTable.tableName,
      PROCESSING_QUEUE_URL: this.processingQueue.queueUrl,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      SECRETS_ARN: apiSecrets.secretArn,
      BRAND_NAME: config.brandName,
      PRIMARY_LANGUAGE: config.primaryLanguage,
      POWERTOOLS_SERVICE_NAME: 'voc-ingestion',
      LOG_LEVEL: 'INFO',
      DEPLOY_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
      DEPLOY_REGION: cdk.Aws.REGION, ...PII_REDACTION_ENV,
    };
  }

  private createDependenciesLayer(): lambda.LayerVersion {
    return new lambda.LayerVersion(this, 'IngestionDepsLayer', {
      code: pythonLayerCode('lambda/layers/ingestion-deps'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_14],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'Common dependencies for ingestion lambdas (ARM64/Graviton)',
    });
  }

  private createIngestorLambda(
    plugin: PluginManifest,
    commonEnv: Record<string, string>,
    dependenciesLayer: lambda.LayerVersion,
    aggregatesTable: dynamodb.Table,
    allPluginIds: string[],
  ): void {
    const infra = plugin.infrastructure.ingestor;
    if (!infra?.enabled) return;

    // Parse schedule from manifest
    const schedule = this.parseSchedule(infra.schedule);

    // ONE string names the schedule three times: on the Rule below, in the
    // role's events:DisableRule grant, and in INGEST_SCHEDULE_RULE_NAME, which
    // the circuit breaker inside the ingestor passes to DisableRule when the
    // plugin keeps failing. Handing the breaker the resolved name (rather than
    // letting it rebuild one) is what keeps all three in step under a
    // deployment prefix too, and its absence tells the breaker there is no rule
    // to disable. Built only when a rule actually exists, so an unscheduled
    // plugin cannot spend name-length budget on a rule the app never creates.
    const scheduleRuleName = schedule
      ? this.uniqueName(`voc-ingest-${plugin.id}-schedule`)
      : undefined;

    // Build environment - some plugins need extra tables
    const lambdaEnv: Record<string, string> = {
      ...commonEnv,
      SOURCE_PLATFORM: plugin.id,
      PLUGIN_ID: plugin.id,
      ...(scheduleRuleName ? { INGEST_SCHEDULE_RULE_NAME: scheduleRuleName } : {}),
    };

    // All plugins need aggregates table for run status tracking
    lambdaEnv.AGGREGATES_TABLE = aggregatesTable.tableName;

    // Bundle plugin code from plugins/ directory
    const ingestorCode = this.bundlePluginCode(plugin.id, allPluginIds);

    // Bedrock-capable and scheduled plugins get a dedicated, scoped role; the rest share one.
    const role = this.ingestorRoles.roleFor(plugin.id, { bedrock: infra.bedrock, scheduleRuleName });

    const fn = new lambda.Function(this, `Ingestor${capitalize(plugin.id)}`, {
      functionName: this.uniqueName(`voc-ingestor-${plugin.id}`),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: ingestorCode,
      role,
      timeout: cdk.Duration.seconds(infra.timeout),
      memorySize: infra.memory,
      environment: lambdaEnv,
      layers: [dependenciesLayer],
      logGroup: new logs.LogGroup(this, `IngestorLogs${capitalize(plugin.id)}`, {
        logGroupName: this.uniqueName(`/aws/lambda/voc-ingestor-${plugin.id}`),
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Create schedule rule if schedule is defined.
    // NOTE the rule name is built HERE, by hand — it does not come from any
    // shared construct — so a change to uniqueName() alone would miss it.
    if (schedule && scheduleRuleName) {
      new events.Rule(this, `Schedule${capitalize(plugin.id)}`, {
        ruleName: scheduleRuleName,
        schedule,
        targets: [new targets.LambdaFunction(fn, {
          retryAttempts: SCHEDULE_TARGET_RETRY_ATTEMPTS,
          maxEventAge: SCHEDULE_TARGET_MAX_EVENT_AGE,
          deadLetterQueue: this.scheduleDeadLetterQueue(),
        })],
        enabled: false, // Disabled by default - enable via Settings UI
      });
    }

    this.ingestionLambdas.set(plugin.id, fn);
  }

  private bundlePluginCode(pluginId: string, allPluginIds: string[]): lambda.Code {
    // Root-based staging (this bundle spans plugins/ AND lambda/shared):
    // everything not excluded feeds the asset hash. The exclude list lives
    // in lambda-asset-excludes.ts — see its doc for why GIT ignore mode
    // (issue #203: GLOB's 'dir/**' leaked dot-children like cdk.out/.cache,
    // churning every ingestor hash on every deploy) and why sibling plugins
    // are excluded per-id (their edits must not redeploy THIS ingestor).
    return lambda.Code.fromAsset('.', {
      exclude: rootPluginAssetExcludes(pluginId, allPluginIds),
      ignoreMode: cdk.IgnoreMode.GIT,
      bundling: {
        image: lambda.Runtime.PYTHON_3_14.bundlingImage,
        command: [
          'bash', '-c', [
            'mkdir -p /asset-output',
            // Copy plugin ingestor code
            `cp -r /asset-input/plugins/${pluginId}/ingestor/* /asset-output/`,
            // Copy plugin shared modules
            'cp -r /asset-input/plugins/_shared /asset-output/',
            // Copy lambda shared modules (logging, aws, http)
            'cp -r /asset-input/lambda/shared /asset-output/',
          ].join(' && '),
        ],
        platform: 'linux/arm64',
      },
    });
  }

  private parseSchedule(scheduleExpr: string | undefined): events.Schedule | null {
    if (!scheduleExpr) return null;

    // Parse rate expressions: rate(5 minutes), rate(1 hour), etc.
    const rateMatch = /^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/.exec(scheduleExpr);
    if (rateMatch) {
      const [, amount = '', unit = ''] = rateMatch;
      const value = parseInt(amount, 10);

      if (unit === 'minute' || unit === 'minutes') {
        return events.Schedule.rate(cdk.Duration.minutes(value));
      }
      if (unit === 'hour' || unit === 'hours') {
        return events.Schedule.rate(cdk.Duration.hours(value));
      }
      if (unit === 'day' || unit === 'days') {
        return events.Schedule.rate(cdk.Duration.days(value));
      }
    }

    // Parse cron expressions
    const cronMatch = /^cron\((.+)\)$/.exec(scheduleExpr);
    if (cronMatch) {
      return events.Schedule.expression(scheduleExpr);
    }

    console.warn(`Unknown schedule expression: ${scheduleExpr}`);
    return null;
  }

  private setupS3Trigger(plugin: PluginManifest): void {
    const s3Trigger = plugin.infrastructure.s3Trigger;
    if (!s3Trigger?.enabled) return;

    const fn = this.ingestionLambdas.get(plugin.id);
    if (!fn) {
      console.warn(`Cannot setup S3 trigger for ${plugin.id}: Lambda not found`);
      return;
    }

    // Grant S3 permissions
    this.s3ImportBucket.grantReadWrite(fn);

    // Add event notifications for each suffix
    for (const suffix of s3Trigger.suffixes) {
      this.s3ImportBucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3n.LambdaDestination(fn),
        { suffix }
      );
    }
  }
}
