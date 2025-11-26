import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface VocIngestionStackProps extends cdk.StackProps {
  feedbackTable: dynamodb.Table;
  watermarksTable: dynamodb.Table;
  aggregatesTable: dynamodb.Table;
  kmsKey: kms.Key;
  config: {
    brandName: string;
    brandHandles: string[];
    primaryLanguage: string;
    enabledSources: string[];
  };
}

export class VocIngestionStack extends cdk.Stack {
  public readonly ingestionLambdas: Map<string, lambda.Function> = new Map();
  public readonly processingQueue: sqs.Queue;
  public readonly secretsArn: string;

  constructor(scope: Construct, id: string, props: VocIngestionStackProps) {
    super(scope, id, props);

    const { feedbackTable, watermarksTable, aggregatesTable, kmsKey, config } = props;

    // Secrets for API credentials
    const apiSecrets = new secretsmanager.Secret(this, 'VocApiSecrets', {
      secretName: 'voc-datalake/api-credentials',
      description: 'API credentials for VoC data sources',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          trustpilot_api_key: '',
          trustpilot_api_secret: '',
          trustpilot_business_unit_id: '',
          google_api_key: '',
          google_location_ids: '',
          twitter_bearer_token: '',
          meta_access_token: '',
          meta_page_id: '',
          meta_instagram_account_id: '',
          reddit_client_id: '',
          reddit_client_secret: '',
          tavily_api_key: '',
          // App Store credentials
          apple_app_id: '',
          apple_country_codes: 'us,gb,de,fr',
          google_play_package_name: '',
          google_play_service_account: '',
          huawei_client_id: '',
          huawei_client_secret: '',
          huawei_app_id: '',
          // Yelp Fusion API
          yelp_api_key: '',
          yelp_business_ids: '',
          // Web scraper configs (JSON array)
          webscraper_configs: '[]',
        }),
        generateStringKey: 'placeholder',
      },
    });

    // DLQ for failed processing
    const dlq = new sqs.Queue(this, 'ProcessingDLQ', {
      queueName: 'voc-processing-dlq',
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      retentionPeriod: cdk.Duration.days(14),
    });

    // Processing Queue - raw items go here for processing
    this.processingQueue = new sqs.Queue(this, 'ProcessingQueue', {
      queueName: 'voc-processing-queue',
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });


    // Common Lambda execution role
    const ingestionRole = new iam.Role(this, 'IngestionLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant permissions
    watermarksTable.grantReadWriteData(ingestionRole);
    aggregatesTable.grantReadWriteData(ingestionRole);  // For scraper progress tracking
    this.processingQueue.grantSendMessages(ingestionRole);
    kmsKey.grantEncryptDecrypt(ingestionRole);
    apiSecrets.grantRead(ingestionRole);

    // Common environment variables
    const commonEnv = {
      WATERMARKS_TABLE: watermarksTable.tableName,
      PROCESSING_QUEUE_URL: this.processingQueue.queueUrl,
      SECRETS_ARN: apiSecrets.secretArn,
      BRAND_NAME: config.brandName,
      BRAND_HANDLES: JSON.stringify(config.brandHandles),
      PRIMARY_LANGUAGE: config.primaryLanguage,
      POWERTOOLS_SERVICE_NAME: 'voc-ingestion',
      LOG_LEVEL: 'INFO',
    };

    // Lambda Layer for common dependencies
    const dependenciesLayer = new lambda.LayerVersion(this, 'IngestionDepsLayer', {
      code: lambda.Code.fromAsset('lambda/layers/ingestion-deps'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'Common dependencies for ingestion lambdas',
    });

    // Source configurations
    const sourceConfigs: Record<string, { schedule: events.Schedule; timeout: cdk.Duration }> = {
      trustpilot: { schedule: events.Schedule.rate(cdk.Duration.minutes(5)), timeout: cdk.Duration.minutes(2) },
      yelp: { schedule: events.Schedule.rate(cdk.Duration.minutes(30)), timeout: cdk.Duration.minutes(2) },
      google_reviews: { schedule: events.Schedule.rate(cdk.Duration.minutes(15)), timeout: cdk.Duration.minutes(2) },
      twitter: { schedule: events.Schedule.rate(cdk.Duration.minutes(1)), timeout: cdk.Duration.minutes(1) },
      instagram: { schedule: events.Schedule.rate(cdk.Duration.minutes(5)), timeout: cdk.Duration.minutes(2) },
      facebook: { schedule: events.Schedule.rate(cdk.Duration.minutes(5)), timeout: cdk.Duration.minutes(2) },
      reddit: { schedule: events.Schedule.rate(cdk.Duration.minutes(5)), timeout: cdk.Duration.minutes(2) },
      tavily: { schedule: events.Schedule.rate(cdk.Duration.minutes(30)), timeout: cdk.Duration.minutes(3) },
      appstore_apple: { schedule: events.Schedule.rate(cdk.Duration.minutes(15)), timeout: cdk.Duration.minutes(2) },
      appstore_google: { schedule: events.Schedule.rate(cdk.Duration.minutes(15)), timeout: cdk.Duration.minutes(2) },
      appstore_huawei: { schedule: events.Schedule.rate(cdk.Duration.minutes(15)), timeout: cdk.Duration.minutes(2) },
      webscraper: { schedule: events.Schedule.rate(cdk.Duration.minutes(15)), timeout: cdk.Duration.minutes(5) },
    };

    // Create Lambda functions for each enabled source
    for (const source of config.enabledSources) {
      if (!sourceConfigs[source]) continue;

      const sourceConfig = sourceConfigs[source];
      
      // Build environment - webscraper needs aggregates table for progress tracking
      const lambdaEnv: Record<string, string> = {
        ...commonEnv,
        SOURCE_PLATFORM: source,
      };
      if (source === 'webscraper') {
        lambdaEnv.AGGREGATES_TABLE = aggregatesTable.tableName;
      }

      const fn = new lambda.Function(this, `Ingestor${this.capitalize(source)}`, {
        functionName: `voc-ingestor-${source}`,
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: 'handler.lambda_handler',
        code: lambda.Code.fromAsset(`lambda/ingestors/${source}`, {
          exclude: ['**/__pycache__', '*.pyc'],
        }),
        role: ingestionRole,
        timeout: sourceConfig.timeout,
        memorySize: 256,
        environment: lambdaEnv,
        layers: [dependenciesLayer],
        logGroup: new logs.LogGroup(this, `IngestorLogs${this.capitalize(source)}`, {
          logGroupName: `/aws/lambda/voc-ingestor-${source}`,
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        // Reserved concurrency removed to avoid account limits
      });

      new events.Rule(this, `Schedule${this.capitalize(source)}`, {
        ruleName: `voc-ingest-${source}-schedule`,
        schedule: sourceConfig.schedule,
        targets: [new targets.LambdaFunction(fn, { retryAttempts: 2 })],
        enabled: false,  // Disabled by default - enable via Settings UI
      });

      this.ingestionLambdas.set(source, fn);
    }

    // Expose secrets ARN for other stacks
    this.secretsArn = apiSecrets.secretArn;

    // Outputs
    new cdk.CfnOutput(this, 'ApiSecretsArn', { value: apiSecrets.secretArn });
    new cdk.CfnOutput(this, 'ProcessingQueueUrl', { value: this.processingQueue.queueUrl });
    new cdk.CfnOutput(this, 'DLQUrl', { value: dlq.queueUrl });
  }

  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
}
