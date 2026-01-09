import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';
import { uniqueBucketName, uniqueTableName, generateDeploymentHash } from '../utils/naming';

export interface VocStorageStackProps extends cdk.StackProps {
  // No frontend domain needed - CORS is handled by individual stacks
}

export class VocStorageStack extends cdk.Stack {
  public readonly feedbackTable: dynamodb.Table;
  public readonly aggregatesTable: dynamodb.Table;
  public readonly watermarksTable: dynamodb.Table;
  public readonly projectsTable: dynamodb.Table;
  public readonly jobsTable: dynamodb.Table;
  public readonly conversationsTable: dynamodb.Table;
  public readonly idempotencyTable: dynamodb.Table;
  public readonly kmsKey: kms.Key;
  public readonly rawDataBucket: s3.Bucket;
  public readonly accessLogsBucket: s3.Bucket;
  public readonly avatarsCdnUrl: string;

  constructor(scope: Construct, id: string, props?: VocStorageStackProps) {
    super(scope, id, props);

    // Generate deployment hash for unique naming
    const hash = generateDeploymentHash(this.account, this.region);

    // CORS allowed origins for S3 buckets - include localhost for dev
    const corsAllowedOrigins = ['http://localhost:5173', 'http://localhost:3000'];

    // KMS Key for encryption at rest
    this.kmsKey = new kms.Key(this, 'VocKmsKey', {
      alias: `voc-datalake-key-${hash}`,
      description: 'KMS key for VoC Data Lake encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // S3 Access Logs Bucket - stores server access logs for audit trail
    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      bucketName: uniqueBucketName('voc-access-logs', this.account, this.region),
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        { expiration: cdk.Duration.days(90) },
      ],
    });

    // S3 Bucket for raw data lake
    // Partitioned structure: raw/{source}/{year}/{month}/{day}/
    // Also stores persona avatars in avatars/{persona_id}.png
    this.rawDataBucket = new s3.Bucket(this, 'RawDataBucket', {
      bucketName: uniqueBucketName('voc-raw-data', this.account, this.region),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.kmsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: 'raw-data-bucket/',
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: corsAllowedOrigins,
          allowedHeaders: ['*'],
          maxAge: 3600,
        },
      ],
    });

    // Response headers policy for CORS on avatar images
    const avatarsCorsPolicy = new cloudfront.ResponseHeadersPolicy(this, 'AvatarsCorsPolicy', {
      responseHeadersPolicyName: `voc-avatars-cors-policy-${hash}`,
      corsBehavior: {
        accessControlAllowOrigins: corsAllowedOrigins,
        accessControlAllowMethods: ['GET', 'HEAD'],
        accessControlAllowHeaders: ['*'],
        accessControlMaxAge: cdk.Duration.hours(1),
        originOverride: true,
        accessControlAllowCredentials: false,
      },
    });

    // CloudFront distribution for serving persona avatar images
    // Only serves from the avatars/ prefix for security
    // Note: Using OAC with KMS-encrypted S3 requires a wildcard in the key policy during initial deployment.
    // After first deploy, you can scope down the policy using the distribution ID.
    // See: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html
    const avatarsDistribution = new cloudfront.Distribution(this, 'AvatarsDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.rawDataBucket, {
          originPath: '/avatars',
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: avatarsCorsPolicy,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: 'VoC Persona Avatars CDN',
    });

    // Acknowledge the KMS wildcard warning - this is expected for initial deployment
    // After deploying, you can manually update the KMS key policy to use the specific distribution ID
    cdk.Annotations.of(this).acknowledgeWarning('@aws-cdk/aws-cloudfront-origins:wildcardKeyPolicyForOac');

    this.avatarsCdnUrl = `https://${avatarsDistribution.distributionDomainName}`;

    // Main Feedback Table - stores all processed feedback
    // PK: source_platform, SK: feedback_id
    // GSI1: by date (for time-based queries)
    // GSI2: by category (for issue analysis)
    // GSI3: by urgency (for alerts)
    this.feedbackTable = new dynamodb.Table(this, 'FeedbackTable', {
      tableName: uniqueTableName('voc-feedback', this.account, this.region),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // GSI1: Query by date (for dashboards and trends)
    // pk: DATE#2024-01-15, sk: timestamp#feedback_id
    this.feedbackTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-by-date',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: Query by category and sentiment
    // pk: CATEGORY#delivery, sk: sentiment_score#timestamp
    this.feedbackTable.addGlobalSecondaryIndex({
      indexName: 'gsi2-by-category',
      partitionKey: { name: 'gsi2pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi2sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI3: Query urgent items
    // pk: URGENCY#high, sk: timestamp
    this.feedbackTable.addGlobalSecondaryIndex({
      indexName: 'gsi3-by-urgency',
      partitionKey: { name: 'gsi3pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi3sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['feedback_id', 'source_platform', 'problem_summary', 'direct_customer_quote', 'source_url'],
    });

    // GSI4: Query by feedback_id (for direct lookups without scanning)
    // pk: feedback_id
    this.feedbackTable.addGlobalSecondaryIndex({
      indexName: 'gsi4-by-feedback-id',
      partitionKey: { name: 'feedback_id', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });


    // Aggregates Table - stores pre-computed metrics
    // PK: METRIC#daily_sentiment, SK: 2024-01-15
    // PK: METRIC#category_count, SK: delivery#2024-01-15
    this.aggregatesTable = new dynamodb.Table(this, 'AggregatesTable', {
      tableName: uniqueTableName('voc-aggregates', this.account, this.region),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // GSI1: Query aggregates by metric type (avoids full table scans)
    // pk: metric_type (e.g., 'source', 'persona'), sk: pk (original pk for sorting)
    this.aggregatesTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-by-metric-type',
      partitionKey: { name: 'metric_type', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Watermarks Table - tracks ingestion state per source
    this.watermarksTable = new dynamodb.Table(this, 'WatermarksTable', {
      tableName: uniqueTableName('voc-watermarks', this.account, this.region),
      partitionKey: { name: 'source', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Projects Table - stores projects with personas, PRDs, PR/FAQs
    // PK: PROJECT#{project_id}, SK: META | PERSONA#{id} | PRD#{id} | PRFAQ#{id} | RESEARCH#{id}
    this.projectsTable = new dynamodb.Table(this, 'ProjectsTable', {
      tableName: uniqueTableName('voc-projects', this.account, this.region),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI for listing all projects
    this.projectsTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-by-type',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Jobs Table - tracks long-running async jobs (research, persona generation, etc.)
    // PK: PROJECT#{project_id}, SK: JOB#{job_id}
    // GSI1: Query jobs by status (for monitoring)
    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      tableName: uniqueTableName('voc-jobs', this.account, this.region),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // GSI1: Query jobs by status for monitoring
    this.jobsTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-by-status',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Conversations Table - stores AI chat conversations
    // PK: USER#default (or user ID when auth is added), SK: CONV#{conversation_id}
    this.conversationsTable = new dynamodb.Table(this, 'ConversationsTable', {
      tableName: uniqueTableName('voc-conversations', this.account, this.region),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // Idempotency Table - used by Lambda Powertools to prevent duplicate processing
    // Required schema: id (PK), expiration (TTL), status, data
    // See: https://docs.powertools.aws.dev/lambda/python/latest/utilities/idempotency/
    this.idempotencyTable = new dynamodb.Table(this, 'IdempotencyTable', {
      tableName: uniqueTableName('voc-idempotency', this.account, this.region),
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,  // OK to lose on stack deletion
      timeToLiveAttribute: 'expiration',
    });

    // Outputs
    new cdk.CfnOutput(this, 'FeedbackTableName', { value: this.feedbackTable.tableName });
    new cdk.CfnOutput(this, 'FeedbackTableArn', { value: this.feedbackTable.tableArn });
    new cdk.CfnOutput(this, 'AggregatesTableName', { value: this.aggregatesTable.tableName });
    new cdk.CfnOutput(this, 'WatermarksTableName', { value: this.watermarksTable.tableName });
    new cdk.CfnOutput(this, 'KmsKeyArn', { value: this.kmsKey.keyArn });
    new cdk.CfnOutput(this, 'ProjectsTableName', { value: this.projectsTable.tableName });
    new cdk.CfnOutput(this, 'JobsTableName', { value: this.jobsTable.tableName });
    new cdk.CfnOutput(this, 'ConversationsTableName', { value: this.conversationsTable.tableName });
    new cdk.CfnOutput(this, 'IdempotencyTableName', { value: this.idempotencyTable.tableName });
    new cdk.CfnOutput(this, 'RawDataBucketName', { value: this.rawDataBucket.bucketName });
    new cdk.CfnOutput(this, 'RawDataBucketArn', { value: this.rawDataBucket.bucketArn });
    new cdk.CfnOutput(this, 'AccessLogsBucketName', { value: this.accessLogsBucket.bucketName });
    new cdk.CfnOutput(this, 'AvatarsCdnUrl', { 
      value: this.avatarsCdnUrl,
      description: 'CloudFront URL for persona avatar images',
    });
  }
}
