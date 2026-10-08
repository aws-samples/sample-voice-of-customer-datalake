import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';
import { ALLOWED_MODEL_IDS, MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION_PX, stackModelArns } from '../utils/model-allowlist';
import { NagSuppressions } from 'cdk-nag';
import { idempotencyTableSuppressions, cdkCustomResourceSuppressions, lambdaBasicExecutionRoleSuppressions, dynamoDbGsiSuppressions, kmsEncryptionSuppressions, s3BucketSuppressions, bedrockModelSuppressions, suppressAwsCustomResourceProvider } from '../utils/nag-suppressions';
import { VocStack, VocStackProps } from '../utils/voc-stack';
import { createCoreAuth } from './core-auth';
import { createCoreCdn, type CoreBuildContext } from './core-cdn';
import { createCoreBuckets } from './core-buckets';
import { ALARM_EMAIL_CONTEXT_KEY, ALARM_NAME_PREFIX, ALARM_TOPIC_BASE_NAME, API_ASYNC_FAILURES_QUEUE_BASE_NAME, AlarmTopic, addQueueDepthAlarm, createApiAsyncFailureQueue, parseAlarmEmail } from './dlq-alarms';

export interface VocCoreStackProps extends VocStackProps {
  brandName: string;
}

interface EncryptedTableOptions {
  /** Defaults to the single-table `pk`/`sk` pair. */
  keys?: { partitionKey: dynamodb.Attribute; sortKey?: dynamodb.Attribute };
  timeToLiveAttribute?: string;
  stream?: dynamodb.StreamViewType;
  /**
   * Customer-data tables (feedback, aggregates, projects) are RETAINed: the
   * data lake never deletes customer data, not even on `cdk destroy`.
   * Defaults to DESTROY for operational tables.
   */
  removalPolicy?: cdk.RemovalPolicy;
}

/**
 * VocCoreStack - Consolidated foundational resources
 * 
 * Merges: VocStorageStack + VocAuthStack + VocFrontendInfraStack
 * 
 * Contains:
 * - DynamoDB tables (feedback, aggregates, watermarks, projects, jobs, conversations, idempotency, memory, agents)
 * - Secrets Manager secret voc/design-integrations (Figma/GitHub tokens for the design system)
 * - KMS encryption key
 * - S3 buckets (raw data, access logs)
 * - CloudFront distributions (avatars CDN, frontend hosting)
 * - Cognito User Pool + Client
 */
export class VocCoreStack extends VocStack {
  // Storage exports
  public readonly feedbackTable: dynamodb.Table;
  public readonly aggregatesTable: dynamodb.Table;
  public readonly watermarksTable: dynamodb.Table;
  public readonly projectsTable: dynamodb.Table;
  public readonly jobsTable: dynamodb.Table;
  public readonly conversationsTable: dynamodb.Table;
  public readonly idempotencyTable: dynamodb.Table;
  /** voc-memory — company/personal memories, their audit events, session cursors, imports. */
  public readonly memoryTable: dynamodb.Table;
  /** voc-agents — autonomous agents, workflow definitions, runs, run events, crewmate transcripts. */
  public readonly agentsTable: dynamodb.Table;
  /**
   * ARN of `voc/design-integrations` — `{figma_token?, github_token?}`, written
   * and read only by the settings API. A string for the same cycle reason as
   * cdnSigningSecretArn: `secret.grantRead()` from ApiStack would add a
   * key-policy entry on this stack's KMS key.
   */
  public readonly designIntegrationsSecretArn: string;
  public readonly kmsKey: kms.Key;
  public readonly rawDataBucket: s3.Bucket;
  public readonly accessLogsBucket: s3.Bucket;
  public readonly avatarsCdnUrl: string;
  public readonly prototypesCdnUrl: string;

  // CloudFront URL-signing material for the private /avatars/* and
  // /prototypes/* paths. Consumed by the API stack, whose Lambdas mint signed
  // URLs for the browser (issue #229).
  //
  // The ARN is exported as a STRING, not the Secret construct, and deliberately:
  // `secret.grantRead(role)` on a CMK-encrypted secret adds a KMS KEY-POLICY
  // statement naming the grantee, and since the key lives here while the roles
  // live in the API stack, that makes CoreStack reference ApiStack and
  // CloudFormation rejects the cycle. Consumers add an explicit
  // `secretsmanager:GetSecretValue` statement instead — the same pattern the
  // ingestion `secretsArn` already uses — and get KMS access from the
  // kmsKey.grantEncryptDecrypt/grantDecrypt calls they already have.
  public readonly cdnSigningSecretArn: string;
  public readonly cdnSigningKeyPairId: string;

  // Frontend infrastructure exports
  public readonly frontendDistribution: cloudfront.Distribution;
  public readonly websiteBucket: s3.Bucket;
  public readonly frontendDomainName: string;

  // Auth exports
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly authenticatedRole: iam.Role;

  constructor(scope: Construct, id: string, props: VocCoreStackProps) {
    super(scope, id, props);

    // Base CORS origins for localhost development
    const corsAllowedOriginsBase = ['http://localhost:5173', 'http://localhost:3000'];

    // ============================================
    // KMS KEY
    // ============================================
    this.kmsKey = new kms.Key(this, 'VocKmsKey', {
      alias: this.uniqueName('voc-datalake-key'),
      description: 'KMS key for VoC Data Lake encryption',
      enableKeyRotation: true,
      // RETAIN: the retained feedback/aggregates/projects tables and the raw
      // bucket are encrypted with this key — scheduling its deletion on
      // `cdk destroy` would make the kept data unreadable.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ============================================
    // OPERATIONAL ALARM TOPIC (#247)
    // ============================================
    // The one topic every DLQ/failure-queue depth alarm notifies; the later
    // stacks import it by this name (lib/stacks/dlq-alarms.ts).
    const opsAlarms = new AlarmTopic(this, 'OpsAlarms', {
      topicName: this.uniqueName(ALARM_TOPIC_BASE_NAME),
      alarmEmail: parseAlarmEmail(this.node.tryGetContext(ALARM_EMAIL_CONTEXT_KEY)),
      alarmNamePrefix: this.prefixed(ALARM_NAME_PREFIX),
    });
    // VocApiStack's async-invoke failure queue (#253) lives HERE with its alarm:
    // that stack is 3 resources under CloudFormation's 500 ceiling with every
    // plugin on. Its Lambdas address the queue by this name (api-stack.ts).
    const apiAsyncFailuresQueueName = this.uniqueName(API_ASYNC_FAILURES_QUEUE_BASE_NAME);
    createApiAsyncFailureQueue(this, 'ApiAsyncInvokeFailures', apiAsyncFailuresQueueName, this.kmsKey);
    addQueueDepthAlarm(this, 'ApiAsyncFailuresDepthAlarm', {
      queueName: apiAsyncFailuresQueueName,
      topic: opsAlarms.topic,
    });

    // ============================================
    // S3 BUCKETS
    // ============================================
    const buckets = createCoreBuckets(this, {
      accessLogs: this.uniqueDnsName('voc-access-logs'),
      rawData: this.uniqueDnsName('voc-raw-data'),
      website: this.uniqueDnsName('voc-frontend'),
    }, this.kmsKey, corsAllowedOriginsBase);
    this.accessLogsBucket = buckets.accessLogsBucket;
    this.rawDataBucket = buckets.rawDataBucket;
    this.websiteBucket = buckets.websiteBucket;

    // ============================================
    // CLOUDFRONT DISTRIBUTIONS (core-cdn.ts)
    // ============================================
    const buildContext: CoreBuildContext = {
      stack: this,
      uniqueName: (baseName) => this.uniqueName(baseName),
      uniqueDnsName: (baseName) => this.uniqueDnsName(baseName),
    };
    const cdn = createCoreCdn(buildContext, {
      kmsKey: this.kmsKey, rawDataBucket: this.rawDataBucket, websiteBucket: this.websiteBucket,
      accessLogsBucket: this.accessLogsBucket,
    });
    this.frontendDistribution = cdn.frontendDistribution;
    this.frontendDomainName = cdn.frontendDomainName;
    this.cdnSigningSecretArn = cdn.cdnSigningSecretArn;
    this.cdnSigningKeyPairId = cdn.cdnSigningKeyPairId;
    this.designIntegrationsSecretArn = cdn.designIntegrationsSecretArn;
    this.avatarsCdnUrl = cdn.avatarsCdnUrl;
    this.prototypesCdnUrl = cdn.prototypesCdnUrl;


    // ============================================
    // DYNAMODB TABLES
    // ============================================

    // Feedback Table
    // Customer data: no TTL, RETAINed on stack deletion (never delete feedback).
    this.feedbackTable = this.createEncryptedTable('FeedbackTable', 'voc-feedback', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    this.addKeyPairIndex(this.feedbackTable, { indexName: 'gsi1-by-date', keyPrefix: 'gsi1' });
    this.addKeyPairIndex(this.feedbackTable, { indexName: 'gsi2-by-category', keyPrefix: 'gsi2' });

    this.feedbackTable.addGlobalSecondaryIndex({
      indexName: 'gsi3-by-urgency',
      partitionKey: { name: 'gsi3pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi3sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['feedback_id', 'source_platform', 'problem_summary', 'direct_customer_quote', 'source_url'],
    });

    this.feedbackTable.addGlobalSecondaryIndex({
      indexName: 'gsi4-by-feedback-id',
      partitionKey: { name: 'feedback_id', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Aggregates Table
    // TTL stays enabled for operational rows (processor logs, voting sessions);
    // METRIC# rows are no longer stamped. The table itself is RETAINed.
    this.aggregatesTable = this.createEncryptedTable('AggregatesTable', 'voc-aggregates', {
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.aggregatesTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-by-metric-type',
      partitionKey: { name: 'metric_type', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Watermarks Table
    this.watermarksTable = this.createEncryptedTable('WatermarksTable', 'voc-watermarks', {
      keys: { partitionKey: { name: 'source', type: dynamodb.AttributeType.STRING } },
    });

    // Projects Table
    this.projectsTable = this.createEncryptedTable('ProjectsTable', 'voc-projects', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.addKeyPairIndex(this.projectsTable, { indexName: 'gsi1-by-type', keyPrefix: 'gsi1' });

    // Jobs Table
    this.jobsTable = this.createEncryptedTable('JobsTable', 'voc-jobs', {
      timeToLiveAttribute: 'ttl',
    });
    this.addKeyPairIndex(this.jobsTable, { indexName: 'gsi1-by-status', keyPrefix: 'gsi1' });

    // Conversations Table
    this.conversationsTable = this.createEncryptedTable('ConversationsTable', 'voc-conversations', {
      timeToLiveAttribute: 'ttl',
    });

    // Memory Table — docs/memory.md. RETAINed: memories are curated company
    // knowledge (forget = tombstone + archive, never a delete), and an
    // embedding re-index from scratch is not something to lose on `cdk destroy`.
    //   MEM#company | MEM#user#{sub} / MEM#{id}        memory item
    //   MEMEVT#{id} / {iso}#{n}                         audit event
    //   MEMCURSOR / SESSION#{session_id}                extraction cursor
    //   MEMIMPORT / {import_id}                         page import record
    // gsi1: gsi1pk = MEMSTATUS#{scope}#{status}, gsi1sk = rank key.
    this.memoryTable = this.createEncryptedTable('MemoryTable', 'voc-memory', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.addKeyPairIndex(this.memoryTable, { indexName: 'gsi1-by-memory-status', keyPrefix: 'gsi1' });

    // Agents Table — docs/autonomous-agents.md. RETAINed: agents, versioned
    // workflow definitions and the run journal are the audit trail of what
    // an agent did to which project.
    //   AGENT#{id} / META                 agent        (gsi1pk AGENTS, gsi1sk name)
    //   WORKFLOW#{id} / REV#{n:06d}|CURRENT  definition (gsi1pk WORKFLOWS)
    //   AGENT#{id} / RUN#{run_id}         run          (gsi1pk RUNS_ACTIVE while running)
    //   RUN#{run_id} / EVT#{seq:08d}      run event
    //   RUN#{run_id} / MATE#{role}#{seq:06d}  crewmate transcript
    this.agentsTable = this.createEncryptedTable('AgentsTable', 'voc-agents', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.addKeyPairIndex(this.agentsTable, { indexName: 'gsi1-by-agents-listing', keyPrefix: 'gsi1' });

    // Idempotency Table
    this.idempotencyTable = new dynamodb.Table(this, 'IdempotencyTable', {
      tableName: this.uniqueName('voc-idempotency'),
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiration',
    });
    NagSuppressions.addResourceSuppressions(this.idempotencyTable, idempotencyTableSuppressions);


    // ============================================
    // PRODUCT DOC EXTRACTOR (S3-triggered)
    // ============================================
    // Turns an uploaded product document (image or .md/.txt) into the plain text
    // that build_product_context_block injects into PRD/PR-FAQ/prototype prompts,
    // and moves the DynamoDB record out of `pending` into `ready` or `failed`.
    //
    // WHY IT LIVES IN CORE-STACK RATHER THAN PROCESSING: CDK parents the
    // notification resource under the BUCKET's construct scope, so calling
    // rawDataBucket.addEventNotification() from the processing stack would put a
    // Custom::S3BucketNotifications in VocCoreStack that references a
    // VocProcessingStack Lambda — while processing already depends on core.
    // CloudFormation rejects that cycle. Keeping the function beside the bucket
    // it is triggered by is the only placement that has no cycle.
    //
    // The `documents` surface default from SURFACE_DEFAULTS in
    // lambda/shared/model_config.py. Declared here rather than imported because
    // the model-allowlist module carries the allowlist, not the per-surface
    // defaults; lambda/product_doc_extractor/test/test_default_model_lockstep.py
    // reads this line as source text and fails if the two ever disagree.
    const documentsSurfaceDefaultModelId = 'global.anthropic.claude-sonnet-5-5';

    const productDocExtractor = new lambda.Function(this, 'ProductDocExtractorLambda', {
      functionName: this.uniqueName('voc-product-doc-extractor'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      // NO `bundling` block, mirroring CdnSigningKeysLambda: the handler is
      // stdlib + boto3 only, so there is nothing to pip-install and CoreStack
      // stays container-free. Depending on lambda/shared/ would need a
      // LayerVersion, and building that layer would drag Docker/finch bundling
      // into this stack — see the handler's module docstring.
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/product_doc_extractor'), {
        exclude: ['test', '__pycache__'],
      }),
      // Must stay well under product_context.py's EXTRACTION_STALL_SECONDS (300),
      // which fails a record that never got extracted: a healthy extraction has
      // to finish inside that window or the API marks it failed on read.
      timeout: cdk.Duration.seconds(120),
      // A Bedrock image description holds one image (<= 3.75MB) plus the reply in
      // memory; 512MB also buys proportionally more CPU for the wait-heavy call.
      memorySize: 512,
      description: 'Extracts text from uploaded project product documents (images via Bedrock)',
      environment: {
        RAW_DATA_BUCKET: this.rawDataBucket.bucketName,
        PROJECTS_TABLE: this.projectsTable.tableName,
        // Read-only: the model picker's per-surface overrides live here.
        AGGREGATES_TABLE: this.aggregatesTable.tableName,
        // Rendered from the one allowlist in lib/utils/model-allowlist.ts, so the
        // handler validates configured models against the same list the IAM
        // grants below are built from — no second copy to rot.
        MODEL_ALLOWLIST: JSON.stringify(ALLOWED_MODEL_IDS),
        DEFAULT_MODEL_ID: documentsSurfaceDefaultModelId,
        MAX_IMAGE_BYTES: String(MAX_IMAGE_BYTES),
        MAX_IMAGE_DIMENSION_PX: String(MAX_IMAGE_DIMENSION_PX),
        // The handler emits structured JSON from a stdlib Formatter (it cannot
        // import powertools — see its module docstring), so these are NOT the
        // POWERTOOLS_* names used by every other function here: a
        // POWERTOOLS_SERVICE_NAME on a function with no powertools would promise
        // a library that is absent. The emitted FIELD is still `service`, so an
        // operator's CloudWatch query is unchanged across functions.
        //
        // A LITERAL, not `uniqueName()`: this is a log label, not a physical
        // resource name, so it must not carry the account/region suffix — every
        // POWERTOOLS_SERVICE_NAME in this app is a bare literal for the same
        // reason. Namespacing it also made the value a CloudFormation token,
        // which is not a string a runtime field can be compared against.
        SERVICE_NAME: 'voc-product-doc-extractor',
        // Hardcoded, matching every other function in this app: LOG_LEVEL is a
        // literal 'INFO' at all 24 definitions across the four stacks, so there is
        // no context key or stack parameter to follow here. Raising verbosity
        // during a diagnosis is an environment-variable change on the deployed
        // function — the handler reads LOG_LEVEL at import (see _log_level), so it
        // needs no stack edit and no code change.
        LOG_LEVEL: 'INFO',
      },
      logGroup: new logs.LogGroup(this, 'ProductDocExtractorLambdaLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Prefix-scoped both ways, and asymmetrically: it reads only what users
    // upload and writes only where its own output goes. Without the narrower
    // write scope this role could overwrite any raw upload in the bucket.
    this.rawDataBucket.grantRead(productDocExtractor, 'projects/*/product_docs/raw/*');
    this.rawDataBucket.grantWrite(productDocExtractor, 'projects/*/product_docs/extracted/*');
    this.projectsTable.grantReadWriteData(productDocExtractor);
    this.aggregatesTable.grantReadData(productDocExtractor);
    this.kmsKey.grantEncryptDecrypt(productDocExtractor);
    productDocExtractor.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: stackModelArns(this),
    }));

    // ONE notification rule, filtered on the broad `projects/` prefix. S3 allows
    // only one prefix per rule and rejects overlapping rules on the same event
    // type, so narrowing this to `product_docs/raw/` would mean a rule per
    // project — impossible, the ids are runtime values. The handler's
    // RAW_KEY_PATTERN guard is what makes the broad prefix safe: it also drops
    // this function's OWN output under `product_docs/extracted/`, which would
    // otherwise re-trigger it in a loop.
    //
    // First use of a `prefix` filter in this repo — the existing notifications
    // (S3 import in the ingestion stack) filter by suffix only.
    this.rawDataBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(productDocExtractor),
      { prefix: 'projects/' },
    );

    // bin/voc-datalake.ts gives this stack only the basic-execution and
    // cdk-assets suppressions, so everything the grants above generate has to be
    // suppressed HERE rather than by widening the stack-level set: prefix-scoped
    // S3 object ARNs, the DynamoDB index/* wildcards, the KMS grant wildcards
    // and the Bedrock cross-region foundation-model ARNs.
    NagSuppressions.addResourceSuppressions(
      productDocExtractor,
      [
        ...lambdaBasicExecutionRoleSuppressions,
        ...s3BucketSuppressions,
        ...dynamoDbGsiSuppressions,
        ...kmsEncryptionSuppressions,
        ...bedrockModelSuppressions,
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Object-level S3 access is already narrowed to the two product-doc prefixes; the trailing wildcard is the object name, and the middle wildcard is the runtime project id.',
          appliesTo: [
            { regex: '/Resource::<.*RawDataBucket.*\\.Arn>/projects/\\*/product_docs/.*/' },
          ],
        },
      ],
      true,
    );
    // addEventNotification synthesizes a CDK-managed custom-resource Lambda that
    // configures the bucket notification. Same treatment as the cr.Provider
    // frameworks above: CDK owns its runtime and its PutBucketNotification
    // grant, neither of which this repo can narrow.
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `${this.stackName}/BucketNotificationsHandler050a0587b7544547bf325f094a3db834`,
      [
        ...cdkCustomResourceSuppressions,
        ...lambdaBasicExecutionRoleSuppressions,
        {
          id: 'AwsSolutions-IAM4',
          reason: 'CDK-managed bucket-notifications handler attaches the AWS-managed Lambda basic execution policy; the construct is not configurable.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'CDK-managed bucket-notifications handler needs s3:PutBucketNotification on the buckets it configures; the construct emits a wildcard resource and is not configurable.',
        },
      ],
      true,
    );


    // ============================================
    // COGNITO AUTH (core-auth.ts)
    // ============================================
    const auth = createCoreAuth(buildContext, this.aggregatesTable, this.frontendDomainName);
    this.userPool = auth.userPool;
    this.userPoolClient = auth.userPoolClient;
    this.userPoolDomain = auth.userPoolDomain;
    this.identityPool = auth.identityPool;
    this.authenticatedRole = auth.authenticatedRole;

    
    // Suppress CDK custom resource Lambda runtime warnings
    // The AwsCustomResource construct creates a singleton Lambda with a deterministic UUID
    suppressAwsCustomResourceProvider(this, this.stackName);

    // ============================================
    // OUTPUTS
    // ============================================
    
    // Storage outputs
    new cdk.CfnOutput(this, 'FeedbackTableName', { value: this.feedbackTable.tableName });
    new cdk.CfnOutput(this, 'FeedbackTableArn', { value: this.feedbackTable.tableArn });
    new cdk.CfnOutput(this, 'AggregatesTableName', { value: this.aggregatesTable.tableName });
    new cdk.CfnOutput(this, 'WatermarksTableName', { value: this.watermarksTable.tableName });
    new cdk.CfnOutput(this, 'ProjectsTableName', { value: this.projectsTable.tableName });
    new cdk.CfnOutput(this, 'JobsTableName', { value: this.jobsTable.tableName });
    new cdk.CfnOutput(this, 'ConversationsTableName', { value: this.conversationsTable.tableName });
    new cdk.CfnOutput(this, 'IdempotencyTableName', { value: this.idempotencyTable.tableName });
    new cdk.CfnOutput(this, 'MemoryTableName', { value: this.memoryTable.tableName });
    new cdk.CfnOutput(this, 'AgentsTableName', { value: this.agentsTable.tableName });
    new cdk.CfnOutput(this, 'DesignIntegrationsSecretArn', { value: this.designIntegrationsSecretArn });
    new cdk.CfnOutput(this, 'KmsKeyArn', { value: this.kmsKey.keyArn });
    new cdk.CfnOutput(this, 'RawDataBucketName', { value: this.rawDataBucket.bucketName });
    new cdk.CfnOutput(this, 'RawDataBucketArn', { value: this.rawDataBucket.bucketArn });
    new cdk.CfnOutput(this, 'AccessLogsBucketName', { value: this.accessLogsBucket.bucketName });
    new cdk.CfnOutput(this, 'AvatarsCdnUrl', { value: this.avatarsCdnUrl, description: 'CloudFront URL for persona avatar images (signature required)' });
    new cdk.CfnOutput(this, 'PrototypesCdnUrl', { value: this.prototypesCdnUrl, description: 'CloudFront URL for generated HTML prototypes (signature required)' });
    new cdk.CfnOutput(this, 'CdnSigningKeyPairId', { value: this.cdnSigningKeyPairId, description: 'CloudFront public key id used to sign /avatars/* and /prototypes/* URLs' });

    // Frontend outputs
    new cdk.CfnOutput(this, 'WebsiteURL', { value: `https://${this.frontendDomainName}`, description: 'CloudFront Distribution URL' });
    new cdk.CfnOutput(this, 'WebsiteBucketName', { value: this.websiteBucket.bucketName, description: 'S3 Bucket Name' });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.frontendDistribution.distributionId, description: 'CloudFront Distribution ID' });
    // The app's ONLY hand-written export name, and therefore the only one the
    // deployment prefix has to namespace by hand: CloudFormation export names
    // are unique per account and region, so an unprefixed literal collides
    // between two copies before any resource name does. (CDK's automatic
    // cross-stack exports are already namespaced, because it derives them from
    // the stack name, which the prefix covers.)
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: this.frontendDomainName, description: 'CloudFront Distribution Domain Name', exportName: this.prefixed('VocFrontendDomainName') });

    // Auth outputs
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId, description: 'Cognito User Pool ID' });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId, description: 'Cognito User Pool Client ID for frontend' });
    new cdk.CfnOutput(this, 'UserPoolDomain', { value: `${auth.domainPrefix}.auth.${this.region}.amazoncognito.com`, description: 'Cognito User Pool Domain' });
    new cdk.CfnOutput(this, 'CognitoRegion', { value: this.region, description: 'AWS Region for Cognito' });
    new cdk.CfnOutput(this, 'IdentityPoolId', { value: this.identityPool.ref, description: 'Cognito Identity Pool ID for AWS IAM auth' });
    new cdk.CfnOutput(this, 'InitialAdminPassword', { 
      value: auth.initialAdminPassword, 
      // ASCII only: CloudFormation mangles non-ASCII in output descriptions
      // ('?'), which makes every subsequent cdk diff dirty.
      description: 'Initial admin password (username: admin) - real only on the deployment that created the admin; forced to change at first login'
    });

    // Acknowledged wildcard-key-policy warning (issue #189): the synthesized
    // KMS condition is already scoped to THIS ACCOUNT's distributions
    // (arn:...:cloudfront::ACCOUNT:distribution/*); scoping to the concrete
    // distribution id would create exactly the circular dependency the
    // warning describes, and the CDK README documents the wildcard as the
    // supported shape. Kept as the LAST statement of the constructor:
    // every withOriginAccessControl() call re-emits the warning, and
    // acknowledgeWarning only strips messages added before it runs — an
    // origin added below the ack would silently re-break warning-free synth.
    cdk.Annotations.of(this).acknowledgeWarning('@aws-cdk/aws-cloudfront-origins:wildcardKeyPolicyForOac');
  }


  /**
   * A platform DynamoDB table: on-demand, encrypted with the stack KMS key,
   * point-in-time recovery on, destroyed with the stack unless a RETAIN
   * `removalPolicy` is passed (customer-data tables). Keys default to the
   * single-table `pk`/`sk` pair.
   */
  private createEncryptedTable(id: string, baseName: string, options: EncryptedTableOptions): dynamodb.Table {
    const keys = options.keys ?? {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    };
    return new dynamodb.Table(this, id, {
      tableName: this.uniqueName(baseName),
      partitionKey: keys.partitionKey,
      sortKey: keys.sortKey,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.kmsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: options.removalPolicy ?? cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: options.timeToLiveAttribute,
      stream: options.stream,
    });
  }

  /**
   * A fully projected GSI keyed by the `<prefix>pk` / `<prefix>sk` string pair
   * the handlers write. Call sites keep the `indexName:` literal because the
   * Python and stream mirrors (lambda/shared/test/test_indexes.py,
   * lambda/stream/src/indexes.test.ts) parse this file for it.
   */
  private addKeyPairIndex(table: dynamodb.Table, index: { indexName: string; keyPrefix: string }): void {
    table.addGlobalSecondaryIndex({
      indexName: index.indexName,
      partitionKey: { name: `${index.keyPrefix}pk`, type: dynamodb.AttributeType.STRING },
      sortKey: { name: `${index.keyPrefix}sk`, type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }

}
