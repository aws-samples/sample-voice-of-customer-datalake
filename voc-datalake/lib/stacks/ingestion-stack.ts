import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
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
  type PluginManifest,
} from '../plugin-loader';
import { uniqueName } from '../utils/naming';
import { NagSuppressions } from 'cdk-nag';
import { apiSecretsSuppressions } from '../utils/nag-suppressions';

export interface VocIngestionStackProps extends cdk.StackProps {
  feedbackTable: dynamodb.Table;
  watermarksTable: dynamodb.Table;
  aggregatesTable: dynamodb.Table;
  rawDataBucket: s3.Bucket;
  accessLogsBucket: s3.Bucket;
  kmsKey: kms.Key;
  config: {
    brandName: string;
    brandHandles: string[];
    primaryLanguage: string;
    enabledSources: string[];
  };
  frontendDomain?: string;
}

export class VocIngestionStack extends cdk.Stack {
  public readonly ingestionLambdas: Map<string, lambda.Function> = new Map();
  public readonly processingQueue: sqs.Queue;
  public readonly secretsArn: string;
  public readonly s3ImportBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: VocIngestionStackProps) {
    super(scope, id, props);

    const { feedbackTable, watermarksTable, aggregatesTable, rawDataBucket, accessLogsBucket, kmsKey, config } = props;



    // Load plugins from manifests
    const pluginsDir = path.join(__dirname, '../../plugins');
    const allPlugins = loadPlugins(pluginsDir);
    const enabledPlugins = getEnabledPlugins(allPlugins, config.enabledSources);

    // CORS allowed origins
    const frontendDomain = props.frontendDomain || this.node.tryGetContext('frontendDomain');
    const corsAllowedOrigins = this.buildCorsOrigins(frontendDomain);

    // S3 Import Bucket
    this.s3ImportBucket = this.createS3ImportBucket(kmsKey, accessLogsBucket, corsAllowedOrigins);

    // Secrets for API credentials - aggregated from all plugins
    const apiSecrets = this.createApiSecrets(allPlugins);

    // DLQ and Processing Queue
    const dlq = this.createDLQ(kmsKey);
    this.processingQueue = this.createProcessingQueue(kmsKey, dlq);

    // Common Lambda execution role
    const ingestionRole = this.createIngestionRole(
      watermarksTable,
      aggregatesTable,
      rawDataBucket,
      kmsKey,
      apiSecrets
    );

    // Common environment variables
    const commonEnv = this.buildCommonEnv(watermarksTable, rawDataBucket, apiSecrets, config);

    // Lambda Layer for common dependencies
    const dependenciesLayer = this.createDependenciesLayer();

    // Create Lambda functions for each enabled plugin with ingestor
    const ingestorPlugins = getPluginsWithIngestor(enabledPlugins);
    for (const plugin of ingestorPlugins) {
      this.createIngestorLambda(
        plugin,
        ingestionRole,
        commonEnv,
        dependenciesLayer,
        aggregatesTable
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
      bucketName: uniqueName('voc-import'),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
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
      secretName: uniqueName('voc-datalake/api-credentials'),
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
    const dlq = new sqs.Queue(this, 'ProcessingDLQ', {
      queueName: uniqueName('voc-processing-dlq'),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Enforce SSL/TLS for queue access
    dlq.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyInsecureTransport',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['sqs:*'],
      resources: [dlq.queueArn],
      conditions: {
        Bool: { 'aws:SecureTransport': 'false' },
      },
    }));

    return dlq;
  }

  private createProcessingQueue(kmsKey: kms.Key, dlq: sqs.Queue): sqs.Queue {
    const queue = new sqs.Queue(this, 'ProcessingQueue', {
      queueName: uniqueName('voc-processing-queue'),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Enforce SSL/TLS for queue access
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

    return queue;
  }

  private createIngestionRole(
    watermarksTable: dynamodb.Table,
    aggregatesTable: dynamodb.Table,
    rawDataBucket: s3.Bucket,
    kmsKey: kms.Key,
    apiSecrets: secretsmanager.Secret
  ): iam.Role {
    const role = new iam.Role(this, 'IngestionLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    watermarksTable.grantReadWriteData(role);
    aggregatesTable.grantReadWriteData(role);
    this.processingQueue.grantSendMessages(role);
    rawDataBucket.grantReadWrite(role);
    kmsKey.grantEncryptDecrypt(role);
    apiSecrets.grantRead(role);

    return role;
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
      BRAND_HANDLES: JSON.stringify(config.brandHandles),
      PRIMARY_LANGUAGE: config.primaryLanguage,
      POWERTOOLS_SERVICE_NAME: 'voc-ingestion',
      LOG_LEVEL: 'INFO',
    };
  }

  private createDependenciesLayer(): lambda.LayerVersion {
    return new lambda.LayerVersion(this, 'IngestionDepsLayer', {
      code: lambda.Code.fromAsset('lambda/layers/ingestion-deps', {
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          platform: 'linux/arm64',
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output/python && cp -r . /asset-output/python/'
          ],
        },
      }),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_14],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'Common dependencies for ingestion lambdas (ARM64/Graviton)',
    });
  }

  private createIngestorLambda(
    plugin: PluginManifest,
    ingestionRole: iam.Role,
    commonEnv: Record<string, string>,
    dependenciesLayer: lambda.LayerVersion,
    aggregatesTable: dynamodb.Table,
  ): void {
    const infra = plugin.infrastructure.ingestor;
    if (!infra?.enabled) return;

    // Build environment - some plugins need extra tables
    const lambdaEnv: Record<string, string> = {
      ...commonEnv,
      SOURCE_PLATFORM: plugin.id,
      PLUGIN_ID: plugin.id,
    };

    // Webscraper needs aggregates table for progress tracking
    if (plugin.id === 'webscraper') {
      lambdaEnv.AGGREGATES_TABLE = aggregatesTable.tableName;
    }

    // Bundle plugin code from plugins/ directory
    const ingestorCode = this.bundlePluginCode(plugin.id);

    // Parse schedule from manifest
    const schedule = this.parseSchedule(infra.schedule);

    const fn = new lambda.Function(this, `Ingestor${capitalize(plugin.id)}`, {
      functionName: uniqueName(`voc-ingestor-${plugin.id}`),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: ingestorCode,
      role: ingestionRole,
      timeout: cdk.Duration.seconds(infra.timeout),
      memorySize: infra.memory,
      environment: lambdaEnv,
      layers: [dependenciesLayer],
      logGroup: new logs.LogGroup(this, `IngestorLogs${capitalize(plugin.id)}`, {
        logGroupName: uniqueName(`/aws/lambda/voc-ingestor-${plugin.id}`),
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Create schedule rule if schedule is defined
    if (schedule) {
      new events.Rule(this, `Schedule${capitalize(plugin.id)}`, {
        ruleName: uniqueName(`voc-ingest-${plugin.id}-schedule`),
        schedule,
        targets: [new targets.LambdaFunction(fn, { retryAttempts: 2 })],
        enabled: false, // Disabled by default - enable via Settings UI
      });
    }

    this.ingestionLambdas.set(plugin.id, fn);
  }

  private bundlePluginCode(pluginId: string): lambda.Code {
    return lambda.Code.fromAsset('.', {
      exclude: ['**/__pycache__', '*.pyc', 'plugins/_template/**', 'node_modules/**', 'cdk.out/**', 'frontend/**', '*.ts', '*.js', '*.json', '*.md', 'bin/**', 'lib/**', 'dist/**', '.venv/**', '.pytest_cache/**'],
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
    const rateMatch = scheduleExpr.match(/^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/);
    if (rateMatch) {
      const value = parseInt(rateMatch[1], 10);
      const unit = rateMatch[2];

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
    const cronMatch = scheduleExpr.match(/^cron\((.+)\)$/);
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
