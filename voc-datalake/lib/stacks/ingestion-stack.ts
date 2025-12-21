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
import { Construct } from 'constructs';

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
  frontendDomain?: string;  // CloudFront domain for CORS (e.g., 'd1234567890.cloudfront.net')
}

export class VocIngestionStack extends cdk.Stack {
  public readonly ingestionLambdas: Map<string, lambda.Function> = new Map();
  public readonly processingQueue: sqs.Queue;
  public readonly secretsArn: string;
  public readonly s3ImportBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: VocIngestionStackProps) {
    super(scope, id, props);

    const { feedbackTable, watermarksTable, aggregatesTable, rawDataBucket, accessLogsBucket, kmsKey, config } = props;

    // CORS allowed origins - restrict to CloudFront domain if provided
    const corsAllowedOrigins = props.frontendDomain 
      ? [`https://${props.frontendDomain}`]
      : ['http://localhost:5173', 'http://localhost:3000'];  // Dev only - update after first deploy

    // S3 Import Bucket - dedicated bucket for feedback file uploads
    // Files uploaded here trigger the S3 import Lambda automatically
    // Structure: {source_name}/{filename}.csv|json|jsonl
    this.s3ImportBucket = new s3.Bucket(this, 'S3ImportBucket', {
      bucketName: `voc-import-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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

    // Secrets for API credentials
    const apiSecrets = new secretsmanager.Secret(this, 'VocApiSecrets', {
      secretName: 'voc-datalake/api-credentials',
      description: 'API credentials for VoC data sources',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          trustpilot_api_key: '',
          trustpilot_api_secret: '',
          trustpilot_business_unit_id: '',
          trustpilot_webhook_secret: '',
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
          // YouTube Data API
          youtube_api_key: '',
          youtube_channel_id: '',
          youtube_video_ids: '',
          youtube_search_terms: '',
          // TikTok API for Business
          tiktok_access_token: '',
          tiktok_refresh_token: '',
          tiktok_client_key: '',
          tiktok_client_secret: '',
          tiktok_business_id: '',
          tiktok_video_ids: '',
          tiktok_research_enabled: 'false',
          // LinkedIn Marketing API
          linkedin_access_token: '',
          linkedin_organization_id: '',
          // S3 Import
          s3_import_bucket: '',
          s3_import_prefix: 'imports/',
          s3_import_processed_prefix: 'processed/',
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
    rawDataBucket.grantReadWrite(ingestionRole);  // For storing raw scraped data
    kmsKey.grantEncryptDecrypt(ingestionRole);
    apiSecrets.grantRead(ingestionRole);

    // Common environment variables
    const commonEnv = {
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
      youtube: { schedule: events.Schedule.rate(cdk.Duration.minutes(10)), timeout: cdk.Duration.minutes(3) },
      tiktok: { schedule: events.Schedule.rate(cdk.Duration.minutes(10)), timeout: cdk.Duration.minutes(2) },
      linkedin: { schedule: events.Schedule.rate(cdk.Duration.minutes(15)), timeout: cdk.Duration.minutes(2) },
      s3_import: { schedule: events.Schedule.rate(cdk.Duration.minutes(5)), timeout: cdk.Duration.minutes(5) },
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

      // Add S3 event notification for s3_import Lambda
      if (source === 's3_import') {
        this.s3ImportBucket.grantReadWrite(fn);
        this.s3ImportBucket.addEventNotification(
          s3.EventType.OBJECT_CREATED,
          new s3n.LambdaDestination(fn),
          { suffix: '.csv' }
        );
        this.s3ImportBucket.addEventNotification(
          s3.EventType.OBJECT_CREATED,
          new s3n.LambdaDestination(fn),
          { suffix: '.json' }
        );
        this.s3ImportBucket.addEventNotification(
          s3.EventType.OBJECT_CREATED,
          new s3n.LambdaDestination(fn),
          { suffix: '.jsonl' }
        );
      }
    }

    // Expose secrets ARN for other stacks
    this.secretsArn = apiSecrets.secretArn;

    // Outputs
    new cdk.CfnOutput(this, 'ApiSecretsArn', { value: apiSecrets.secretArn });
    new cdk.CfnOutput(this, 'ProcessingQueueUrl', { value: this.processingQueue.queueUrl });
    new cdk.CfnOutput(this, 'DLQUrl', { value: dlq.queueUrl });
    new cdk.CfnOutput(this, 'S3ImportBucketName', { value: this.s3ImportBucket.bucketName });
    new cdk.CfnOutput(this, 'S3ImportBucketArn', { value: this.s3ImportBucket.bucketArn });
  }

  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }
}
