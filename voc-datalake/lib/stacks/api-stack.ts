import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as path from 'path';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { loadPlugins, getEnabledPlugins, getPluginsWithWebhook, capitalize, type PluginManifest } from '../plugin-loader';
import { assertFrontendBuildFresh } from '../utils/assert-frontend-build';
import { cdkCustomResourceSuppressions, apiGatewayRequestValidationSuppressions, publicFeedbackEndpointSuppressions, publicBallotEndpointSuppressions, pluginSystemSuppressions, cdkAssetsSuppressions, marketplaceSuppressions } from '../utils/nag-suppressions';
import { allowlistedModelArns, imageModelArn } from '../utils/model-allowlist';
import { pythonLayerCode } from '../utils/python-layer-bundling';
import { PY_LAMBDA_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { VocStack, VocStackProps } from '../utils/voc-stack';
import { SOURCE_PLACEHOLDER } from '../utils/naming';

export interface VocApiStackProps extends VocStackProps {
  // Core stack resources
  feedbackTable: dynamodb.Table;
  aggregatesTable: dynamodb.Table;
  projectsTable: dynamodb.Table;
  jobsTable: dynamodb.Table;
  conversationsTable: dynamodb.Table;
  kmsKey: kms.Key;
  rawDataBucket: s3.Bucket;
  avatarsCdnUrl: string;
  prototypesCdnUrl: string;
  // CloudFront URL-signing material for the private /avatars/* and
  // /prototypes/* behaviors (issue #229). Only the Lambdas that hand asset
  // URLs to a browser get read access to the secret.
  //
  // An ARN string, not the Secret construct: `secret.grantRead()` would add a
  // KMS key-policy statement naming these roles, and the key lives in CoreStack
  // — that makes CoreStack depend on ApiStack, which is a cycle. Same reason the
  // ingestion `secretsArn` above is a string.
  cdnSigningSecretArn: string;
  cdnSigningKeyPairId: string;
  websiteBucket: s3.Bucket;
  frontendDistribution: cloudfront.Distribution;
  frontendDomainName: string;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  identityPool: cognito.CfnIdentityPool;
  authenticatedRole: iam.Role;

  // Ingestion stack resources
  processingQueueUrl: string;
  processingQueueArn: string;
  secretsArn: string;
  s3ImportBucket: s3.Bucket;

  // Processing stack resources
  researchStateMachine: sfn.StateMachine;
  // Web search (AgentCore Gateway) — absent when the feature isn't deployed
  // (non-us-east-1 regions or enableWebSearch=false).
  webSearchGatewayUrl?: string;
  webSearchGatewayArn?: string;
  webSearchToolName?: string;

  // Config
  brandName: string;
  enabledSources: string[];  // Plugin IDs enabled in pluginStatus
}

/**
 * VocApiStack - Consolidated API and Frontend deployment
 * 
 * Merges: VocAnalyticsStack + VocFrontendStack
 * 
 * Contains:
 * - API Gateway with all REST endpoints
 * - All API Lambda functions (metrics, integrations, scrapers, settings, chat, projects, etc.)
 * - Webhook Lambdas for plugins
 * - Frontend S3 deployment
 */
export class VocApiStack extends VocStack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: VocApiStackProps) {
    super(scope, id, props);

    const {
      feedbackTable, aggregatesTable, projectsTable, jobsTable, conversationsTable,
      kmsKey, rawDataBucket, avatarsCdnUrl, prototypesCdnUrl,
      cdnSigningSecretArn, cdnSigningKeyPairId, websiteBucket, frontendDistribution,
      frontendDomainName, userPool, userPoolClient, identityPool, processingQueueUrl, processingQueueArn,
      secretsArn, s3ImportBucket, researchStateMachine, brandName,
      webSearchGatewayUrl, webSearchGatewayArn, webSearchToolName
    } = props;

    // Guard: fail fast (before any asset bundling) if frontend/dist is missing
    // or stale, so an out-of-date UI can never be shipped. CDK packages
    // frontend/dist as-is via s3deploy.Source.asset and never rebuilds it.
    // Bypass with: cdk deploy -c skipFrontendBuildCheck=true (or SKIP_FRONTEND_BUILD_CHECK=1).
    assertFrontendBuildFresh({
      frontendRoot: path.join(__dirname, '../../frontend'),
      skip: this.node.tryGetContext('skipFrontendBuildCheck') === true
        || this.node.tryGetContext('skipFrontendBuildCheck') === 'true',
    });



    // CORS configuration - defaults to production
    // Set context environment=dev to allow localhost for local development
    const environment = this.node.tryGetContext('environment') || 'production'
    const isDev = environment === 'dev' || environment === 'development'
    
    if (isDev) {
      console.log('WARNING: Deploying in DEV mode with CORS=* for local development')
    }
    
    const allowedOrigin = isDev ? '*' : `https://${frontendDomainName}`; 

    // Shared Lambda Layer
    const apiLayer = new lambda.LayerVersion(this, 'ApiDepsLayer', {
      code: pythonLayerCode('lambda/layers/processing-deps'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_14],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'Dependencies for API lambdas (ARM64/Graviton)',
    });

    /**
     * Creates an optimized Lambda code bundle containing only the specified handler
     * and the shared modules. This reduces deployment size and improves cold start times.
     * 
     * @param handlerFileName - The handler file name (e.g., 'metrics_handler.py')
     * @returns Lambda Code asset with only the required files
     */
    const createApiLambdaCode = (handlerFileName: string): lambda.Code => {
      return lambda.Code.fromAsset('lambda', {
        // Stages only api/ + shared/ — everything else is hash noise.
        exclude: [...PY_LAMBDA_ASSET_EXCLUDES, '/aggregator/', '/jobs/', '/processor/', '/research/'],
        ignoreMode: cdk.IgnoreMode.GIT,
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          command: [
            'bash', '-c',
            `mkdir -p /asset-output && ` +
            `cp /asset-input/api/${handlerFileName} /asset-output/ && ` +
            `cp -r /asset-input/shared /asset-output/ && ` +
            `if [ -f /asset-input/api/projects.py ]; then cp /asset-input/api/projects.py /asset-output/; fi && ` +
            `if [ -f /asset-input/api/product_context.py ]; then cp /asset-input/api/product_context.py /asset-output/; fi && ` +
            // INVARIANT: prompts land at the bundle ROOT (/var/task/prompts) —
            // shared/prompts.py::get_prompts_dir resolves that path first and
            // its other branches are dev-only. Keep it root-level.
            `if [ -d /asset-input/api/prompts ]; then cp -r /asset-input/api/prompts /asset-output/; fi && ` +
            `if [ -d /asset-input/api/static ]; then cp -r /asset-input/api/static /asset-output/; fi`
          ],
          platform: 'linux/arm64',
        },
      });
    };

    // ============================================
    // LAMBDA FUNCTIONS
    // ============================================

    // Metrics API
    const metricsRole = this.createLambdaRole('MetricsLambdaRole');
    feedbackTable.grantReadData(metricsRole);
    aggregatesTable.grantReadWriteData(metricsRole);
    kmsKey.grantEncryptDecrypt(metricsRole);

    const metricsLambda = new lambda.Function(this, 'MetricsApi', {
      functionName: this.uniqueName('voc-metrics-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'metrics_handler.lambda_handler',
      code: createApiLambdaCode('metrics_handler.py'),
      role: metricsRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        ALLOWED_ORIGIN: allowedOrigin,
        POWERTOOLS_SERVICE_NAME: 'voc-metrics-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('MetricsApiLogs', this.uniqueName('voc-metrics-api')),
    });

    // Integrations API
    const integrationsRole = this.createLambdaRole('IntegrationsLambdaRole');
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
      resources: [`arn:aws:events:${this.region}:${this.account}:rule/${this.prefixed('voc-ingest')}-*-schedule*`],
    }));
    integrationsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${this.prefixed('voc-ingestor')}-*`],
    }));
    NagSuppressions.addResourceSuppressions(integrationsRole, pluginSystemSuppressions(this.deploymentPrefix), true);

    const integrationsLambda = new lambda.Function(this, 'IntegrationsApi', {
      functionName: this.uniqueName('voc-integrations-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'integrations_handler.lambda_handler',
      code: createApiLambdaCode('integrations_handler.py'),
      role: integrationsRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      // POST /sources/{source}/run and the enable/disable routes address a
      // PER-PLUGIN ingestor and schedule rule, so one fixed name will not do —
      // but resolving the pattern is still the infrastructure's job, not the
      // handler's, exactly as WEBSCRAPER_FUNCTION_NAME and
      // MANUAL_IMPORT_PROCESSOR_FUNCTION are already handed down. Rebuilding
      // the name in Python from DEPLOY_ACCOUNT_ID/DEPLOY_REGION would, under a
      // prefix, invoke a function that does not exist — a ResourceNotFound the
      // user experiences as "the scraper runs but pulls no reviews".
      environment: { SECRETS_ARN: secretsArn, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-integrations-api', LOG_LEVEL: 'INFO', DEPLOY_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID, DEPLOY_REGION: cdk.Aws.REGION, ...this.prefixOnlyEnv({
        INGESTOR_FUNCTION_NAME_PATTERN: this.uniqueNamePattern(`voc-ingestor-${SOURCE_PLACEHOLDER}`),
        INGEST_SCHEDULE_RULE_NAME_PATTERN: this.uniqueNamePattern(`voc-ingest-${SOURCE_PLACEHOLDER}-schedule`),
      }), AGGREGATES_TABLE: aggregatesTable.tableName },
      layers: [apiLayer],
      logGroup: this.createLogGroup('IntegrationsApiLogs', this.uniqueName('voc-integrations-api')),
    });
    aggregatesTable.grantReadWriteData(integrationsRole);

    // Scrapers API
    const scrapersRole = this.createLambdaRole('ScrapersLambdaRole');
    aggregatesTable.grantReadWriteData(scrapersRole);
    kmsKey.grantEncryptDecrypt(scrapersRole);
    scrapersRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
      resources: [secretsArn],
    }));
    scrapersRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${this.prefixed('voc-ingestor-webscraper')}-*`],
    }));
    NagSuppressions.addResourceSuppressions(scrapersRole, pluginSystemSuppressions(this.deploymentPrefix), true);
    scrapersRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: allowlistedModelArns(this.region, this.account),
    }));
    // AWS Marketplace permissions required for Bedrock model access
    scrapersRole.addToPolicy(new iam.PolicyStatement({
      actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
      resources: ['*'],
    }));
    NagSuppressions.addResourceSuppressions(scrapersRole, marketplaceSuppressions, true);

    const scrapersLambda = new lambda.Function(this, 'ScrapersApi', {
      functionName: this.uniqueName('voc-scrapers-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'scrapers_handler.lambda_handler',
      code: createApiLambdaCode('scrapers_handler.py'),
      role: scrapersRole,
      // 120s headroom for large CSV uploads (batched SQS sends). The API
      // Gateway 29s integration limit is the real ceiling on sync uploads;
      // this just keeps the Lambda from dying before that.
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: { SECRETS_ARN: secretsArn, AGGREGATES_TABLE: aggregatesTable.tableName, WEBSCRAPER_FUNCTION_NAME: this.uniqueName('voc-ingestor-webscraper'), ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-scrapers-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('ScrapersApiLogs', this.uniqueName('voc-scrapers-api')),
    });


    // Manual Import API
    const manualImportRole = this.createLambdaRole('ManualImportLambdaRole');
    aggregatesTable.grantReadWriteData(manualImportRole);
    kmsKey.grantEncryptDecrypt(manualImportRole);
    manualImportRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));
    manualImportRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${this.prefixed('voc-manual-import-processor')}-*`] }));
    NagSuppressions.addResourceSuppressions(manualImportRole, pluginSystemSuppressions(this.deploymentPrefix), true);
    rawDataBucket.grantReadWrite(manualImportRole);

    const manualImportLambda = new lambda.Function(this, 'ManualImportApi', {
      functionName: this.uniqueName('voc-manual-import-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'manual_import_handler.lambda_handler',
      code: createApiLambdaCode('manual_import_handler.py'),
      role: manualImportRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        AGGREGATES_TABLE: aggregatesTable.tableName,
        PROCESSING_QUEUE_URL: processingQueueUrl,
        RAW_DATA_BUCKET: rawDataBucket.bucketName,
        MANUAL_IMPORT_PROCESSOR_FUNCTION: this.uniqueName('voc-manual-import-processor'),
        ALLOWED_ORIGIN: allowedOrigin,
        POWERTOOLS_SERVICE_NAME: 'voc-manual-import-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('ManualImportApiLogs', this.uniqueName('voc-manual-import-api')),
    });

    // Manual Import Processor (async)
    const manualImportProcessorRole = this.createLambdaRole('ManualImportProcessorRole');
    aggregatesTable.grantReadWriteData(manualImportProcessorRole);
    kmsKey.grantEncryptDecrypt(manualImportProcessorRole);
    manualImportProcessorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: allowlistedModelArns(this.region, this.account),
    }));

    new lambda.Function(this, 'ManualImportProcessor', {
      functionName: this.uniqueName('voc-manual-import-processor'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'manual_import_processor.lambda_handler',
      code: createApiLambdaCode('manual_import_processor.py'),
      role: manualImportProcessorRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: { AGGREGATES_TABLE: aggregatesTable.tableName, POWERTOOLS_SERVICE_NAME: 'voc-manual-import-processor', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('ManualImportProcessorLogs', this.uniqueName('voc-manual-import-processor')),
    });

    // Settings API
    const settingsRole = this.createLambdaRole('SettingsLambdaRole');
    aggregatesTable.grantReadWriteData(settingsRole);
    kmsKey.grantEncryptDecrypt(settingsRole);
    settingsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: allowlistedModelArns(this.region, this.account),
    }));

    const settingsLambda = new lambda.Function(this, 'SettingsApi', {
      functionName: this.uniqueName('voc-settings-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'settings_handler.lambda_handler',
      code: createApiLambdaCode('settings_handler.py'),
      role: settingsRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { AGGREGATES_TABLE: aggregatesTable.tableName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-settings-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('SettingsApiLogs', this.uniqueName('voc-settings-api')),
    });

    // Logs API
    const logsRole = this.createLambdaRole('LogsLambdaRole');
    aggregatesTable.grantReadWriteData(logsRole);
    kmsKey.grantDecrypt(logsRole);

    const logsLambda = new lambda.Function(this, 'LogsApi', {
      functionName: this.uniqueName('voc-logs-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'logs_handler.lambda_handler',
      code: createApiLambdaCode('logs_handler.py'),
      role: logsRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { AGGREGATES_TABLE: aggregatesTable.tableName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-logs-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('LogsApiLogs', this.uniqueName('voc-logs-api')),
    });

    // Users API
    const usersRole = this.createLambdaRole('UsersLambdaRole');
    usersRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminCreateUser', 'cognito-idp:AdminUpdateUserAttributes', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup', 'cognito-idp:AdminResetUserPassword', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminDisableUser', 'cognito-idp:AdminDeleteUser'],
      resources: [userPool.userPoolArn],
    }));

    const usersLambda = new lambda.Function(this, 'UsersApi', {
      functionName: this.uniqueName('voc-users-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'users_handler.lambda_handler',
      code: createApiLambdaCode('users_handler.py'),
      role: usersRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { USER_POOL_ID: userPool.userPoolId, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-users-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('UsersApiLogs', this.uniqueName('voc-users-api')),
    });

    // Feedback Form API
    const feedbackFormRole = this.createLambdaRole('FeedbackFormLambdaRole');
    aggregatesTable.grantReadWriteData(feedbackFormRole);
    feedbackTable.grantReadData(feedbackFormRole);
    kmsKey.grantEncryptDecrypt(feedbackFormRole);
    feedbackFormRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));

    const feedbackFormLambda = new lambda.Function(this, 'FeedbackFormApi', {
      functionName: this.uniqueName('voc-feedback-form-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'feedback_form_handler.lambda_handler',
      code: createApiLambdaCode('feedback_form_handler.py'),
      role: feedbackFormRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { AGGREGATES_TABLE: aggregatesTable.tableName, FEEDBACK_TABLE: feedbackTable.tableName, PROCESSING_QUEUE_URL: processingQueueUrl, BRAND_NAME: brandName, POWERTOOLS_SERVICE_NAME: 'voc-feedback-form-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('FeedbackFormApiLogs', this.uniqueName('voc-feedback-form-api')),
    });

    // Anonymous Ballots API (voting sessions)
    //
    // Its OWN Lambda, its own role and its own resource tree, because two of its
    // routes are served without credentials. A public route carved out of the
    // authenticated /projects proxy is the shape that once left form update,
    // delete and submission reads anonymous (see api-stack.test.ts), and the
    // feedback-form routes are public for a customer widget rather than for this.
    //
    // ONE TABLE, and only one: the aggregates table, which holds both the voting
    // session records and the prioritization ballots. Deliberately NO feedback
    // table and NO processing-queue grant — a ballot is a decision record, not
    // customer voice, so it must never be enriched, given a sentiment or assigned
    // a persona. The absent grants are what enforce that rather than remember it.
    //
    // THREE ACTIONS, not `grantReadWriteData`. That convenience method hands over
    // Query, Scan, DeleteItem, BatchGetItem and BatchWriteItem across the WHOLE
    // aggregates table, which also holds every feedback-form configuration and
    // every signed-in reviewer's ballot — and this is the one function in the
    // stack that two unauthenticated routes can reach. The handler reads one item
    // at a time (`get_item`), creates a session (`put_item`) and upserts
    // (`update_item`); it never lists, never deletes, never writes in bulk. So a
    // caller who found a flaw in it still cannot enumerate the table or erase
    // anybody's vote. `ballots Lambda IAM grants` in api-stack.test.ts pins both
    // the three actions and the absence of the rest.
    const ballotsRole = this.createLambdaRole('BallotsLambdaRole');
    aggregatesTable.grant(ballotsRole, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem');
    kmsKey.grantEncryptDecrypt(ballotsRole);

    const ballotsLambda = new lambda.Function(this, 'BallotsApi', {
      functionName: this.uniqueName('voc-ballots-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'ballots_handler.lambda_handler',
      code: createApiLambdaCode('ballots_handler.py'),
      role: ballotsRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        AGGREGATES_TABLE: aggregatesTable.tableName,
        // The SAME origin every other API Lambda gets, not '*'. A phone reaches
        // the ballot page by opening `/vote/{id}` on this app's own CloudFront
        // domain, so the browser sends that domain as its Origin exactly as it
        // does for every other page — being unauthenticated changes nothing about
        // where the page is served from. And '*' here would loosen the three
        // FACILITATOR routes too, which live on this same function.
        ALLOWED_ORIGIN: allowedOrigin,
        POWERTOOLS_SERVICE_NAME: 'voc-ballots-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('BallotsApiLogs', this.uniqueName('voc-ballots-api')),
    });

    // Chat API
    const chatRole = this.createLambdaRole('ChatLambdaRole');
    feedbackTable.grantReadData(chatRole);
    aggregatesTable.grantReadWriteData(chatRole);
    conversationsTable.grantReadWriteData(chatRole);
    kmsKey.grantEncryptDecrypt(chatRole);
    chatRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: allowlistedModelArns(this.region, this.account),
    }));

    const chatLambda = new lambda.Function(this, 'ChatApi', {
      functionName: this.uniqueName('voc-chat-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'chat_handler.lambda_handler',
      code: createApiLambdaCode('chat_handler.py'),
      role: chatRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: { FEEDBACK_TABLE: feedbackTable.tableName, AGGREGATES_TABLE: aggregatesTable.tableName, CONVERSATIONS_TABLE: conversationsTable.tableName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-chat-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('ChatApiLogs', this.uniqueName('voc-chat-api')),
    });


    // Projects API
    const projectsRole = this.createLambdaRole('ProjectsLambdaRole');
    feedbackTable.grantReadData(projectsRole);
    aggregatesTable.grantReadWriteData(projectsRole);
    projectsTable.grantReadWriteData(projectsRole);
    jobsTable.grantReadWriteData(projectsRole);
    kmsKey.grantEncryptDecrypt(projectsRole);
    projectsRole.addToPolicy(new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [researchStateMachine.stateMachineArn] }));
    projectsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        ...allowlistedModelArns(this.region, this.account),
        // Persona avatar image generation. Single-sourced in model-allowlist.ts
        // so the grant tracks the model through its EOL migration.
        imageModelArn(),
      ],
    }));

    rawDataBucket.grantReadWrite(projectsRole, 'avatars/*');
    // Product context: projects API needs to issue presigned PUT URLs, read extracted text, delete docs.
    rawDataBucket.grantReadWrite(projectsRole, 'projects/*/product_docs/*');
    // Signs the avatar and prototype URLs returned by GET /projects/{id}.
    // Explicit statement rather than secret.grantRead(): that adds a KMS
    // key-policy entry naming this role, and the key lives in CoreStack, so it
    // would create a CoreStack -> ApiStack cycle. KMS access already comes from
    // kmsKey.grantEncryptDecrypt(projectsRole) above.
    projectsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [cdnSigningSecretArn],
    }));

    const projectsLambda = new lambda.Function(this, 'ProjectsApi', {
      functionName: this.uniqueName('voc-projects-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'projects_handler.lambda_handler',
      code: createApiLambdaCode('projects_handler.py'),
      role: projectsRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        PROJECTS_TABLE: projectsTable.tableName,
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        JOBS_TABLE: jobsTable.tableName,
        RESEARCH_STATE_MACHINE_ARN: researchStateMachine.stateMachineArn,
        RAW_DATA_BUCKET: rawDataBucket.bucketName,
        AVATARS_CDN_URL: avatarsCdnUrl,
        PROTOTYPES_CDN_URL: prototypesCdnUrl,
        CDN_SIGNING_SECRET_ARN: cdnSigningSecretArn,
        CDN_SIGNING_KEY_PAIR_ID: cdnSigningKeyPairId,
        ALLOWED_ORIGIN: allowedOrigin,
        POWERTOOLS_SERVICE_NAME: 'voc-projects-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('ProjectsApiLogs', this.uniqueName('voc-projects-api')),
    });

    // ── Async job Lambdas (persona/document generation) invoked by the Projects API ──
    const createJobLambdaCode = (jobFolder: string): lambda.Code => {
      return lambda.Code.fromAsset('lambda', {
        // Stages only jobs/ + api/ (projects.py, product_context.py, prompts) + shared/.
        exclude: [...PY_LAMBDA_ASSET_EXCLUDES, '/aggregator/', '/processor/', '/research/'],
        ignoreMode: cdk.IgnoreMode.GIT,
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          command: [
            'bash', '-c',
            `mkdir -p /asset-output/api && ` +
            `cp /asset-input/jobs/${jobFolder}/handler.py /asset-output/ && ` +
            `cp -r /asset-input/shared /asset-output/ && ` +
            `cp /asset-input/api/projects.py /asset-output/api/ && ` +
            // document_generator's handle_job() does `from api.product_context import ...`
            // for both the product_report doc_type and the PRD/PR-FAQ product-context
            // injection — this file must ship in the bundle or both paths fail/degrade.
            `cp /asset-input/api/product_context.py /asset-output/api/ && ` +
            // INVARIANT: prompts land at the bundle ROOT (/var/task/prompts) —
            // shared/prompts.py::get_prompts_dir resolves that path first.
            `cp -r /asset-input/api/prompts /asset-output/prompts`
          ],
          platform: 'linux/arm64',
        },
      });
    };

    // Every allowlisted model (issue #96) so any AI surface can be repointed
    // via the picker. Single source of truth kept in lockstep with
    // lambda/shared/model_config.py and lambda/stream/src/bedrock/model-override.ts.
    const claudeModelResources = allowlistedModelArns(this.region, this.account);
    // Persona avatar image model — see model-allowlist.ts for its EOL deadline.
    const avatarImageModelResource = imageModelArn();

    // Persona Generator Job Lambda
    const personaGeneratorRole = this.createLambdaRole('PersonaGeneratorRole');
    feedbackTable.grantReadData(personaGeneratorRole);
    projectsTable.grantReadWriteData(personaGeneratorRole);
    jobsTable.grantReadWriteData(personaGeneratorRole);
    aggregatesTable.grantReadData(personaGeneratorRole);
    kmsKey.grantEncryptDecrypt(personaGeneratorRole);
    personaGeneratorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [...claudeModelResources, avatarImageModelResource],
    }));
    rawDataBucket.grantReadWrite(personaGeneratorRole, 'avatars/*');

    const personaGeneratorLambda = new lambda.Function(this, 'PersonaGeneratorJob', {
      functionName: this.uniqueName('voc-job-persona-generator'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: createJobLambdaCode('persona_generator'),
      role: personaGeneratorRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        PROJECTS_TABLE: projectsTable.tableName,
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        JOBS_TABLE: jobsTable.tableName,
        RAW_DATA_BUCKET: rawDataBucket.bucketName,
        AVATARS_CDN_URL: avatarsCdnUrl,
        POWERTOOLS_SERVICE_NAME: 'voc-job-persona-generator',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('PersonaGeneratorJobLogs', this.uniqueName('voc-job-persona-generator')),
    });

    // Document Generator Job Lambda (PRD/PRFAQ)
    const documentGeneratorRole = this.createLambdaRole('DocumentGeneratorRole');
    feedbackTable.grantReadData(documentGeneratorRole);
    projectsTable.grantReadWriteData(documentGeneratorRole);
    jobsTable.grantReadWriteData(documentGeneratorRole);
    // Model picker: read per-surface overrides (documents/prototype) from aggregates.
    aggregatesTable.grantReadData(documentGeneratorRole);
    kmsKey.grantEncryptDecrypt(documentGeneratorRole);
    documentGeneratorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      // Opus 5 (the prototype-builder default) is now part of the allowlist,
      // so claudeModelResources already covers it — no separate grant needed.
      resources: claudeModelResources,
    }));
    // Product context: read extracted product-doc text when generating PRD/PR-FAQ.
    rawDataBucket.grantRead(documentGeneratorRole, 'projects/*/product_docs/extracted/*');
    // Prototype HTML: write new prototypes + read prior ones (feedback-driven
    // regeneration reads the prior prototype's HTML back out of S3). Scoped to
    // this prefix only, not a bucket-wide grant.
    rawDataBucket.grantReadWrite(documentGeneratorRole, 'prototypes/*');

    const documentGeneratorLambda = new lambda.Function(this, 'DocumentGeneratorJob', {
      functionName: this.uniqueName('voc-job-document-generator'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: createJobLambdaCode('document_generator'),
      role: documentGeneratorRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        PROJECTS_TABLE: projectsTable.tableName,
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        JOBS_TABLE: jobsTable.tableName,
        RAW_DATA_BUCKET: rawDataBucket.bucketName,
        // No PROTOTYPES_CDN_URL: this job writes prototype HTML to S3 but no
        // longer builds its URL. That moved to the projects API, which signs it
        // per request (issue #229).
        POWERTOOLS_SERVICE_NAME: 'voc-job-document-generator',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('DocumentGeneratorJobLogs', this.uniqueName('voc-job-document-generator')),
    });

    // Document Merger Job Lambda
    const documentMergerRole = this.createLambdaRole('DocumentMergerRole');
    feedbackTable.grantReadData(documentMergerRole);
    projectsTable.grantReadWriteData(documentMergerRole);
    jobsTable.grantReadWriteData(documentMergerRole);
    // Model picker: read the documents-surface override from aggregates.
    aggregatesTable.grantReadData(documentMergerRole);
    kmsKey.grantEncryptDecrypt(documentMergerRole);
    documentMergerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: claudeModelResources,
    }));

    const documentMergerLambda = new lambda.Function(this, 'DocumentMergerJob', {
      functionName: this.uniqueName('voc-job-document-merger'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: createJobLambdaCode('document_merger'),
      role: documentMergerRole,
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
      environment: {
        PROJECTS_TABLE: projectsTable.tableName,
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        JOBS_TABLE: jobsTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'voc-job-document-merger',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('DocumentMergerJobLogs', this.uniqueName('voc-job-document-merger')),
    });

    // Persona Importer Job Lambda
    const personaImporterRole = this.createLambdaRole('PersonaImporterRole');
    projectsTable.grantReadWriteData(personaImporterRole);
    jobsTable.grantReadWriteData(personaImporterRole);
    // Model picker: read the documents-surface override from aggregates.
    aggregatesTable.grantReadData(personaImporterRole);
    kmsKey.grantEncryptDecrypt(personaImporterRole);
    personaImporterRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [...claudeModelResources, avatarImageModelResource],
    }));
    rawDataBucket.grantReadWrite(personaImporterRole, 'avatars/*');

    const personaImporterLambda = new lambda.Function(this, 'PersonaImporterJob', {
      functionName: this.uniqueName('voc-job-persona-importer'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: createJobLambdaCode('persona_importer'),
      role: personaImporterRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        PROJECTS_TABLE: projectsTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        JOBS_TABLE: jobsTable.tableName,
        RAW_DATA_BUCKET: rawDataBucket.bucketName,
        AVATARS_CDN_URL: avatarsCdnUrl,
        POWERTOOLS_SERVICE_NAME: 'voc-job-persona-importer',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('PersonaImporterJobLogs', this.uniqueName('voc-job-persona-importer')),
    });

    // Wire job Lambda function names into the Projects API + grant invoke
    projectsLambda.addEnvironment('PERSONA_GENERATOR_FUNCTION', personaGeneratorLambda.functionName);
    projectsLambda.addEnvironment('DOCUMENT_GENERATOR_FUNCTION', documentGeneratorLambda.functionName);
    projectsLambda.addEnvironment('DOCUMENT_MERGER_FUNCTION', documentMergerLambda.functionName);
    projectsLambda.addEnvironment('PERSONA_IMPORTER_FUNCTION', personaImporterLambda.functionName);
    personaGeneratorLambda.grantInvoke(projectsRole);
    documentGeneratorLambda.grantInvoke(projectsRole);
    documentMergerLambda.grantInvoke(projectsRole);
    personaImporterLambda.grantInvoke(projectsRole);

    // PRD/PR-FAQ generation runs as a Step Functions workflow: each LLM step is
    // its own Lambda invocation, so a long CJK document (whose steps auto-continue
    // past maxTokens and can run minutes each) never overruns the single 15-min
    // Lambda budget. Intermediate step text is stashed in S3 (claim-check) under
    // scratch/document_jobs/* — SF state stays well under its 256KB ceiling.
    rawDataBucket.grantReadWrite(documentGeneratorRole, 'scratch/document_jobs/*');
    const documentStateMachine = this.createDocumentStateMachine(documentGeneratorLambda);
    documentStateMachine.grantStartExecution(projectsRole);
    projectsLambda.addEnvironment('DOCUMENT_STATE_MACHINE_ARN', documentStateMachine.stateMachineArn);

    // Chat Stream (Node.js — API Gateway response streaming, replaces Python Function URL)
    const chatStreamLambda = new NodejsFunction(this, 'ChatStreamApi', {
      functionName: this.uniqueName('voc-chat-stream'),
      entry: path.join(__dirname, '../../lambda/stream/src/handler.ts'),
      // The nodeModules install step below pairs CDK's generated minimal
      // package.json with a copied lockfile. Without this, CDK discovers the
      // CDK app's root package-lock.json (which doesn't contain the stream
      // Lambda's deps) and `npm ci` fails with EUSAGE at bundling time.
      depsLockFilePath: path.join(__dirname, '../../lambda/stream/package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(5),
      environment: {
        PROJECTS_TABLE: projectsTable.tableName,
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        // Streaming-chat ('chat' surface) default when no override is set.
        // Bumped Sonnet 4.5 → Sonnet 5 (latest). The per-surface picker can
        // override this at runtime via model-override.ts.
        BEDROCK_MODEL_ID: 'global.anthropic.claude-sonnet-5',
        AVATARS_CDN_URL: avatarsCdnUrl,
        // This Lambda emits persona avatar URLs in the persona_turn SSE event,
        // which the SPA renders directly, so it has to sign them too (issue #229).
        CDN_SIGNING_SECRET_ARN: cdnSigningSecretArn,
        CDN_SIGNING_KEY_PAIR_ID: cdnSigningKeyPairId,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      bundling: {
        format: OutputFormat.ESM,
        mainFields: ['module', 'main'],
        externalModules: [
          '@aws-sdk/*',
          '@smithy/*',
        ],
        // The web-search SigV4 client imports these directly; bundle them so
        // it runs against the pinned versions from package.json instead of
        // whatever the managed runtime's SDK happens to hoist (transitive
        // availability is not a documented contract). They are tiny.
        nodeModules: [
          '@aws-sdk/credential-provider-node',
          '@smithy/protocol-http',
          '@smithy/signature-v4',
          // Reads the CloudFront URL-signing key. Pinned here for the same
          // reason as the three above: `externalModules: ['@aws-sdk/*']` would
          // otherwise leave it to whatever the managed runtime hoists.
          '@aws-sdk/client-secrets-manager',
        ],
      },
      logGroup: this.createLogGroup('ChatStreamLogs', this.uniqueName('voc-chat-stream')),
    });

    // Bedrock permissions — InvokeModelWithResponseStream. Grant every
    // allowlisted model so the 'chat' surface can be repointed via the picker.
    chatStreamLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: allowlistedModelArns(this.region, this.account),
    }));
    // AWS Marketplace permissions required for Bedrock model access
    chatStreamLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
      resources: ['*'],
    }));
    // Signs the persona avatar URLs emitted in the persona_turn SSE event.
    // Explicit statement, not secret.grantRead() — same cycle reason as the
    // projects role. kmsKey.grantDecrypt(chatStreamLambda) covers the CMK.
    chatStreamLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [cdnSigningSecretArn],
    }));
    NagSuppressions.addResourceSuppressions(chatStreamLambda, marketplaceSuppressions, true);

    // DynamoDB permissions
    feedbackTable.grantReadData(chatStreamLambda);
    aggregatesTable.grantReadData(chatStreamLambda);
    // Scoped projects table access: Query (context), UpdateItem (doc edits), PutItem (doc creation) — no DeleteItem
    chatStreamLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
      ],
      resources: [projectsTable.tableArn, `${projectsTable.tableArn}/index/*`],
    }));
    kmsKey.grantDecrypt(chatStreamLambda);

    // Web search tool (AgentCore Gateway) — optional, opt-in per request.
    // Without the gateway the env vars stay unset and the tool is never
    // registered with the model. Collapse the three optional props into one
    // narrowed value so enablement is decided exactly once.
    const webSearch = webSearchGatewayUrl && webSearchGatewayArn && webSearchToolName
      ? { gatewayUrl: webSearchGatewayUrl, gatewayArn: webSearchGatewayArn, toolName: webSearchToolName }
      : undefined;
    if (webSearch) {
      chatStreamLambda.addEnvironment('WEB_SEARCH_GATEWAY_URL', webSearch.gatewayUrl);
      chatStreamLambda.addEnvironment('WEB_SEARCH_TOOL_NAME', webSearch.toolName);
      chatStreamLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [webSearch.gatewayArn],
      }));
    }

    NagSuppressions.addResourceSuppressions(chatStreamLambda, [
      { id: 'AwsSolutions-L1', reason: 'Node.js 22 is the target runtime for the streaming Lambda — latest stable LTS' },
    ], true);

    // S3 Import API
    const s3ImportRole = this.createLambdaRole('S3ImportLambdaRole');
    s3ImportBucket.grantReadWrite(s3ImportRole);
    kmsKey.grantEncryptDecrypt(s3ImportRole);

    const s3ImportLambda = new lambda.Function(this, 'S3ImportApi', {
      functionName: this.uniqueName('voc-s3-import-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 's3_import_handler.lambda_handler',
      code: createApiLambdaCode('s3_import_handler.py'),
      role: s3ImportRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { S3_IMPORT_BUCKET: s3ImportBucket.bucketName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-s3-import-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('S3ImportApiLogs', this.uniqueName('voc-s3-import-api')),
    });

    // Data Explorer API
    const dataExplorerRole = this.createLambdaRole('DataExplorerLambdaRole');
    rawDataBucket.grantReadWrite(dataExplorerRole);
    feedbackTable.grantReadWriteData(dataExplorerRole);
    kmsKey.grantEncryptDecrypt(dataExplorerRole);
    dataExplorerRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));

    const dataExplorerLambda = new lambda.Function(this, 'DataExplorerApi', {
      functionName: this.uniqueName('voc-data-explorer-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'data_explorer_handler.lambda_handler',
      code: createApiLambdaCode('data_explorer_handler.py'),
      role: dataExplorerRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        RAW_DATA_BUCKET: rawDataBucket.bucketName,
        FEEDBACK_TABLE: feedbackTable.tableName,
        PROCESSING_QUEUE_URL: processingQueueUrl,
        ALLOWED_ORIGIN: allowedOrigin,
        POWERTOOLS_SERVICE_NAME: 'voc-data-explorer-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('DataExplorerApiLogs', this.uniqueName('voc-data-explorer-api')),
    });

    // ============================================
    // WEBHOOKS
    // ============================================
    const pluginsDir = path.join(__dirname, '../../plugins');
    const allPlugins = loadPlugins(pluginsDir);
    const enabledPlugins = getEnabledPlugins(allPlugins, props.enabledSources);
    const webhookPlugins = getPluginsWithWebhook(enabledPlugins);

    const webhookRole = this.createLambdaRole('WebhookLambdaRole');
    feedbackTable.grantReadWriteData(webhookRole);
    kmsKey.grantEncryptDecrypt(webhookRole);
    webhookRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));
    webhookRole.addToPolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [secretsArn] }));

    const webhookLambdas = new Map<string, lambda.Function>();
    for (const plugin of webhookPlugins) {
      const webhookFn = this.createWebhookLambda(plugin, webhookRole, apiLayer, processingQueueUrl, feedbackTable.tableName, secretsArn, brandName);
      webhookLambdas.set(plugin.id, webhookFn);
    }


    // ============================================
    // API GATEWAY
    // ============================================

    // API Gateway CloudWatch Logs
    const apiLogGroup = new logs.LogGroup(this, 'ApiGatewayLogs', {
      logGroupName: `/aws/apigateway/${this.uniqueName('voc-analytics-api')}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.api = new apigateway.RestApi(this, 'VocAnalyticsApi', {
      restApiName: this.uniqueName('voc-analytics-api'),
      description: 'Voice of the Customer Analytics API v2',
      deployOptions: {
        stageName: 'v1',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        // Tighter limits on the two UNAUTHENTICATED ballot methods (see
        // /voting-sessions/* below). Each request costs a DynamoDB read even for a
        // session id that does not exist, and nothing in front of them asks who is
        // calling — the session token is checked inside the handler, which means
        // the cost is paid before the refusal.
        //
        // As STAGE METHOD SETTINGS rather than as a usage plan, which is what the
        // /mcp route uses: a usage plan's throttle binds per API KEY, and these
        // methods deliberately require none, so a plan attached to them would
        // never apply to the requests that matter. Method settings are keyed by
        // path and apply to every caller.
        //
        // 20/s with a burst of 40 is roughly 30x what the feature needs — a room
        // is bounded by MAX_BALLOT_CAP (200) ballots and submits once each — while
        // still cutting a scripted flood down to something a single small table
        // absorbs.
        methodOptions: {
          '/voting-sessions/{session_id}/config/GET': { throttlingRateLimit: 20, throttlingBurstLimit: 40 },
          '/voting-sessions/{session_id}/submit/POST': { throttlingRateLimit: 20, throttlingBurstLimit: 40 },
          // The MCP endpoint gets the same treatment for the same reason: its
          // caller holds a bearer token, not a Cognito session, and an invalid
          // token still costs a DynamoDB Query before the 401. This REPLACES the
          // former McpUsagePlan, which never bound — a usage plan's throttle
          // applies per API KEY and no MCP client sends one (SEC-10's fourth
          // sub-claim, open since #260). 20/40 rather than the ballots' numbers
          // by coincidence, not inheritance: an agent's tool loop is bursty, and
          // a legitimate session fires a handful of calls per model turn, so a
          // burst of 40 absorbs it while still capping a token brute-force at
          // ~1.7M attempts/day against a 2^256 space.
          '/mcp/POST': { throttlingRateLimit: 20, throttlingBurstLimit: 40 },
          // CONCRETE VERBS on the proxy path — the only forms the service
          // accepts, established by a failed deploy plus update-stage probes
          // (2026-08-18): `/{path}/*` is rejected ("Method paths can be
          // defined as {resource_path}/{http_method} ... or */* for
          // overriding all methods in the stage") and `ANY` is rejected as an
          // httpMethod too; `/{proxy+}/GET` is accepted. POST covers JSON-RPC
          // sent to subpaths; GET covers /mcp/autoseed/{project_id}. The
          // handler answers every other verb 405 before any DynamoDB read,
          // and OPTIONS is the gateway's CORS mock, so these two are the
          // complete set of verbs that cost anything. Other verbs on the
          // proxy (PUT, DELETE, …) deliberately ride the stage default
          // (100/200) — their whole cost is a Lambda invoke returning 405,
          // and that ceiling is the intended one.
          '/mcp/{proxy+}/POST': { throttlingRateLimit: 20, throttlingBurstLimit: 40 },
          '/mcp/{proxy+}/GET': { throttlingRateLimit: 20, throttlingBurstLimit: 40 },
        },
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Amz-Date', 'X-Amz-Security-Token'],
        exposeHeaders: ['Content-Type'],
      },
      cloudWatchRoleRemovalPolicy: cdk.RemovalPolicy.DESTROY
    });

    NagSuppressions.addResourceSuppressions(this.api, apiGatewayRequestValidationSuppressions, true);

    // Gateway responses for CORS on errors
    this.api.addGatewayResponse('Default4XX', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: { 'Access-Control-Allow-Origin': "'*'", 'Access-Control-Allow-Headers': "'Content-Type,Authorization,X-Requested-With,X-Amz-Date,X-Amz-Security-Token'", 'Access-Control-Allow-Methods': "'GET,POST,PUT,DELETE,OPTIONS'" },
    });
    this.api.addGatewayResponse('Default5XX', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: { 'Access-Control-Allow-Origin': "'*'", 'Access-Control-Allow-Headers': "'Content-Type,Authorization,X-Requested-With,X-Amz-Date,X-Amz-Security-Token'", 'Access-Control-Allow-Methods': "'GET,POST,PUT,DELETE,OPTIONS'" },
    });
    // API-WIDE, deliberately: this fires on every gateway-GENERATED 401 —
    // the MCP token authorizer refusing a malformed Bearer shape, AND the
    // Cognito authorizer rejecting any other route. The challenge is truthful
    // for both, because every credential this API accepts arrives as
    // `Authorization: Bearer …` (a Cognito ID token is a bearer token), so
    // RFC 6750's challenge is the right answer everywhere. A gateway response
    // is also the ONLY place this header can be set on a REST API: 401s
    // produced INSIDE a Lambda proxy integration have it unconditionally
    // remapped to `x-amzn-remapped-www-authenticate` (documented, no opt-out
    // — verified live 2026-08-18), so mcp_handler keeps sending it and
    // clients on that path receive it under the remapped name.
    // Pinned by 'unauthorized gateway response' in api-stack.test.ts.
    this.api.addGatewayResponse('Unauthorized', {
      type: apigateway.ResponseType.UNAUTHORIZED,
      responseHeaders: {
        'Access-Control-Allow-Origin': "'*'",
        'Access-Control-Allow-Headers': "'Content-Type,Authorization,X-Requested-With,X-Amz-Date,X-Amz-Security-Token'",
        'Access-Control-Allow-Methods': "'GET,POST,PUT,DELETE,OPTIONS'",
        'WWW-Authenticate': '\'Bearer error="invalid_token"\'',
        'Access-Control-Expose-Headers': "'WWW-Authenticate'",
      },
    });

    // Cognito Authorizer
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'VocCognitoAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'voc-cognito-authorizer',
      identitySource: 'method.request.header.Authorization',
    });

    const authMethodOptions: apigateway.MethodOptions = { authorizer: cognitoAuthorizer, authorizationType: apigateway.AuthorizationType.COGNITO };

    // Lambda integrations
    const metricsIntegration = new apigateway.LambdaIntegration(metricsLambda, { proxy: true });
    const integrationsIntegration = new apigateway.LambdaIntegration(integrationsLambda, { proxy: true });
    const scrapersIntegration = new apigateway.LambdaIntegration(scrapersLambda, { proxy: true });
    const settingsIntegration = new apigateway.LambdaIntegration(settingsLambda, { proxy: true });
    const usersIntegration = new apigateway.LambdaIntegration(usersLambda, { proxy: true });
    const feedbackFormIntegration = new apigateway.LambdaIntegration(feedbackFormLambda, { proxy: true });
    const chatIntegration = new apigateway.LambdaIntegration(chatLambda, { proxy: true });
    const chatStreamIntegration = new apigateway.LambdaIntegration(chatStreamLambda, { proxy: true });
    const projectsIntegration = new apigateway.LambdaIntegration(projectsLambda, { proxy: true });
    const manualImportIntegration = new apigateway.LambdaIntegration(manualImportLambda, { proxy: true });
    const logsIntegration = new apigateway.LambdaIntegration(logsLambda, { proxy: true });
    const s3ImportIntegration = new apigateway.LambdaIntegration(s3ImportLambda, { proxy: true });
    const dataExplorerIntegration = new apigateway.LambdaIntegration(dataExplorerLambda, { proxy: true });
    const ballotsIntegration = new apigateway.LambdaIntegration(ballotsLambda, { proxy: true });

    // ============================================
    // API ROUTES
    // ============================================

    // /feedback/*
    const feedbackResource = this.api.root.addResource('feedback');
    feedbackResource.addMethod('GET', metricsIntegration, authMethodOptions);
    const feedbackIdResource = feedbackResource.addResource('{id}');
    feedbackIdResource.addMethod('GET', metricsIntegration, authMethodOptions);
    feedbackIdResource.addResource('similar').addMethod('GET', metricsIntegration, authMethodOptions);
    feedbackResource.addResource('urgent').addMethod('GET', metricsIntegration, authMethodOptions);
    feedbackResource.addResource('entities').addMethod('GET', metricsIntegration, authMethodOptions);
    feedbackResource.addResource('search').addMethod('GET', metricsIntegration, authMethodOptions);
    const problemsResource = feedbackResource.addResource('problems');
    problemsResource.addResource('resolved').addMethod('GET', metricsIntegration, authMethodOptions);
    const problemIdResource = problemsResource.addResource('{problemId}');
    const problemResolveResource = problemIdResource.addResource('resolve');
    problemResolveResource.addMethod('PUT', metricsIntegration, authMethodOptions);
    problemResolveResource.addMethod('DELETE', metricsIntegration, authMethodOptions);

    // /metrics/* — proxy to metrics Lambda
    const metricsResource = this.api.root.addResource('metrics');
    metricsResource.addProxy({ defaultIntegration: metricsIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // /chat/*
    const chatResource = this.api.root.addResource('chat');
    chatResource.addMethod('POST', chatIntegration, authMethodOptions);
    const chatStreamResource = chatResource.addResource('stream');
    const chatStreamMethod = chatStreamResource.addMethod('POST', chatStreamIntegration, authMethodOptions);
    chatResource.addResource('conversations').addProxy({ defaultIntegration: chatIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // Apply API Gateway response-streaming overrides to /chat/stream.
    // Cast through `unknown` to the L1 CfnMethod type — `defaultChild` is typed as
    // `IConstruct | undefined` so a direct cast is rejected by the type checker.
    const chatStreamMethodChild = chatStreamMethod.node.defaultChild
    if (!(chatStreamMethodChild instanceof apigateway.CfnMethod)) {
      throw new TypeError('Expected chatStreamMethod.node.defaultChild to be an apigateway.CfnMethod');
    }
    const chatStreamCfnMethod = chatStreamMethodChild;
    chatStreamCfnMethod.addPropertyOverride('Integration.ResponseTransferMode', 'STREAM');
    chatStreamCfnMethod.addPropertyOverride('Integration.TimeoutInMillis', 300000);
    chatStreamCfnMethod.addPropertyOverride(
      'Integration.Uri',
      `arn:aws:apigateway:${this.region}:lambda:path/2021-11-15/functions/${chatStreamLambda.functionArn}/response-streaming-invocations`
    );

    // /integrations/*
    // {source} uses a greedy proxy so all sub-paths (credentials, apps, apps/{id})
    // route to the integrations Lambda, which owns the routing.
    const integrationsResource = this.api.root.addResource('integrations');
    integrationsResource.addResource('status').addMethod('GET', integrationsIntegration, authMethodOptions);
    const intSourceResource = integrationsResource.addResource('{source}');
    intSourceResource.addProxy({ defaultIntegration: integrationsIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // /sources/*
    // {source} uses a greedy proxy so all sub-paths (enable, disable, run)
    // route to the integrations Lambda.
    const sourcesResource = this.api.root.addResource('sources');
    sourcesResource.addResource('status').addMethod('GET', integrationsIntegration, authMethodOptions);
    const srcSourceResource = sourcesResource.addResource('{source}');
    srcSourceResource.addProxy({ defaultIntegration: integrationsIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // /scrapers/*
    const scrapersResource = this.api.root.addResource('scrapers');
    scrapersResource.addMethod('GET', scrapersIntegration, authMethodOptions);
    scrapersResource.addMethod('POST', scrapersIntegration, authMethodOptions);
    const manualResource = scrapersResource.addResource('manual');
    const manualParseResource = manualResource.addResource('parse');
    manualParseResource.addMethod('POST', manualImportIntegration, authMethodOptions);
    manualParseResource.addResource('{jobId}').addMethod('GET', manualImportIntegration, authMethodOptions);
    manualResource.addResource('confirm').addMethod('POST', manualImportIntegration, authMethodOptions);
    manualResource.addResource('json-upload').addMethod('POST', manualImportIntegration, authMethodOptions);
    manualResource.addResource('csv-upload').addMethod('POST', manualImportIntegration, authMethodOptions);
    scrapersResource.addProxy({ defaultIntegration: scrapersIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // /s3-import/* — proxy to s3 import Lambda
    const s3ImportResource = this.api.root.addResource('s3-import');
    s3ImportResource.addProxy({ defaultIntegration: s3ImportIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // /data-explorer/* — proxy to data explorer Lambda
    const dataExplorerResource = this.api.root.addResource('data-explorer');
    dataExplorerResource.addProxy({ defaultIntegration: dataExplorerIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // /settings/* — proxy to settings Lambda
    const settingsResource = this.api.root.addResource('settings');
    settingsResource.addProxy({ defaultIntegration: settingsIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // /logs/* — proxy to logs Lambda
    const logsResource = this.api.root.addResource('logs');
    logsResource.addProxy({ defaultIntegration: logsIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // /users/*
    const usersResource = this.api.root.addResource('users');
    usersResource.addMethod('GET', usersIntegration, authMethodOptions);
    usersResource.addMethod('POST', usersIntegration, authMethodOptions);
    usersResource.addProxy({ defaultIntegration: usersIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // /feedback-forms/* (multiple forms)
    //
    // Item routes are declared EXPLICITLY instead of behind an `anyMethod` proxy.
    // A proxy with no `defaultMethodOptions` defaults every method to
    // AuthorizationType.NONE, which published form update, form delete and reads
    // of submitted customer feedback with no credentials at all. Explicit routes
    // fail closed: a new handler route is unreachable until it is wired here,
    // rather than silently inheriting a catch-all's (absent) authorization.
    //
    // Only the three routes the embeddable widget needs stay public — verified
    // against lambda/api/static/feedback-widget.js (config + submit) plus the
    // /iframe embed variant, which a browser navigates to directly. Keep this
    // list and lambda/api/feedback_form_handler.py in step: every route the
    // handler registers needs a method here, and api-stack.test.ts asserts that
    // only these three are unauthenticated.
    //
    // Do NOT reintroduce a {proxy+} here to avoid the two-step upgrade it costs
    // on already-deployed environments: {form_id} and {proxy+} cannot coexist as
    // sibling variable paths, which is what makes the upgrade two deploys. See
    // docs/deployment.md, "A sibling ({proxy+}) of this resource...".
    const feedbackFormsResource = this.api.root.addResource('feedback-forms');
    feedbackFormsResource.addMethod('GET', feedbackFormIntegration, authMethodOptions);
    feedbackFormsResource.addMethod('POST', feedbackFormIntegration, authMethodOptions);

    // One-shot flag for upgrading an environment that still has the old
    // /feedback-forms/{proxy+}. CloudFormation creates new resources before
    // deleting old ones inside a single update, so {form_id} and {proxy+} would
    // exist together and API Gateway rejects two variable path parts at one
    // level. Deploy once with -c skipFeedbackFormItemRoutes=true to retire the
    // proxy, then deploy again without it to create these routes.
    //
    // Absent (the default, and always for fresh deployments) this is a no-op —
    // the synthesized template is identical either way. Never leave it set:
    // while it is on, the per-form routes do not exist and the embeddable widget
    // is down. See docs/deployment.md.
    //
    // TODO(cleanup): this flag exists only to migrate environments deployed
    // before the item routes became explicit. Once every environment has run the
    // two-deploy upgrade, delete the flag, this branch and its tests — a
    // permanently available "skip the authorization-bearing routes" switch is a
    // footgun once nothing needs it.
    const skipFeedbackFormItemRoutes =
      this.node.tryGetContext('skipFeedbackFormItemRoutes') === true
      || this.node.tryGetContext('skipFeedbackFormItemRoutes') === 'true';

    if (skipFeedbackFormItemRoutes) {
      cdk.Annotations.of(this).addWarningV2(
        'voc:skipFeedbackFormItemRoutes',
        'skipFeedbackFormItemRoutes is set: /feedback-forms/{form_id}/* is NOT being deployed. '
        + 'This is the first of two upgrade deploys — re-deploy without the flag to restore the routes.',
      );
    } else {
      const feedbackFormItem = feedbackFormsResource.addResource('{form_id}');
      feedbackFormItem.addMethod('GET', feedbackFormIntegration, authMethodOptions);
      feedbackFormItem.addMethod('PUT', feedbackFormIntegration, authMethodOptions);
      feedbackFormItem.addMethod('DELETE', feedbackFormIntegration, authMethodOptions);
      feedbackFormItem.addResource('submissions').addMethod('GET', feedbackFormIntegration, authMethodOptions);
      feedbackFormItem.addResource('stats').addMethod('GET', feedbackFormIntegration, authMethodOptions);

      // Intentionally unauthenticated: the widget runs on the customer's own site.
      const publicFeedbackFormMethods = [
        feedbackFormItem.addResource('config').addMethod('GET', feedbackFormIntegration),
        feedbackFormItem.addResource('submit').addMethod('POST', feedbackFormIntegration),
        feedbackFormItem.addResource('iframe').addMethod('GET', feedbackFormIntegration),
      ];
      for (const publicMethod of publicFeedbackFormMethods) {
        NagSuppressions.addResourceSuppressions(publicMethod, publicFeedbackEndpointSuppressions);
      }
    }

    // /projects/*
    const projectsResource = this.api.root.addResource('projects');
    projectsResource.addMethod('GET', projectsIntegration, authMethodOptions);
    projectsResource.addMethod('POST', projectsIntegration, authMethodOptions);
    projectsResource.addProxy({ defaultIntegration: projectsIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // /voting-sessions/* — a room scores one document from their phones.
    //
    // NOT under /projects: that resource ends in a {proxy+} carrying the Cognito
    // authorizer, and the two routes below that a phone reaches have no
    // credentials at all. A public exception inside an authenticated proxy is the
    // defect shape api-stack.test.ts exists to catch, so this gets its own tree.
    //
    // Every method is declared EXPLICITLY, with no {proxy+} anywhere: a proxy
    // without `defaultMethodOptions` defaults to AuthorizationType.NONE, which is
    // how three feedback-form routes became anonymous. Explicit methods fail
    // closed — a route the handler registers is unreachable until it is wired
    // here, which is the direction to fail in for a handler that accepts writes
    // from anyone holding a link.
    const votingSessionsResource = this.api.root.addResource('voting-sessions');
    votingSessionsResource.addMethod('POST', ballotsIntegration, authMethodOptions);
    const votingSessionItem = votingSessionsResource.addResource('{session_id}');
    votingSessionItem.addMethod('GET', ballotsIntegration, authMethodOptions);
    votingSessionItem.addResource('close').addMethod('POST', ballotsIntegration, authMethodOptions);

    // Intentionally unauthenticated: the room votes from personal phones with no
    // account. The SESSION is the control — a ballot is accepted only against a
    // valid unguessable session token, only while that session is open and
    // unexpired, and only up to its ballot cap (enforced by a conditional atomic
    // increment on the session record). `config` is what lets the page say "this
    // session is closed" instead of showing a blank form.
    //
    // These two are named in INTENTIONALLY_PUBLIC_ROUTES in api-stack.test.ts.
    // That list is the review gate: adding to it is a deliberate act, and the test
    // failing until it is extended is the intended behaviour.
    //
    // Both are throttled below the stage default by `deployOptions.methodOptions`
    // at the top of this stack — keyed by these exact paths, and pinned against
    // them by a test, because a mistyped key throttles nothing and says nothing.
    const publicBallotMethods = [
      votingSessionItem.addResource('config').addMethod('GET', ballotsIntegration),
      votingSessionItem.addResource('submit').addMethod('POST', ballotsIntegration),
    ];
    for (const publicMethod of publicBallotMethods) {
      NagSuppressions.addResourceSuppressions(publicMethod, publicBallotEndpointSuppressions);
    }


    // /webhooks/{pluginId}
    const webhooksResource = this.api.root.addResource('webhooks');
    for (const plugin of webhookPlugins) {
      const webhookFn = webhookLambdas.get(plugin.id);
      if (!webhookFn || !plugin.infrastructure.webhook) continue;
      const webhookIntegration = new apigateway.LambdaIntegration(webhookFn, { proxy: true });
      const pluginResource = webhooksResource.addResource(plugin.id);
      for (const method of plugin.infrastructure.webhook.methods) {
        pluginResource.addMethod(method, webhookIntegration);
      }
    }

    // ============================================
    // MCP SERVER API (public — auth via Bearer token authorizer)
    // ============================================
    const mcpRole = this.createLambdaRole('McpLambdaRole');
    feedbackTable.grantReadData(mcpRole);
    aggregatesTable.grantReadData(mcpRole);
    // TWO ACTIONS on the projects table, not `grantReadWriteData`. The handler
    // Queries token rows (auth) and project/persona rows (the get_project and
    // list_personas tools), and UpdateItems exactly one attribute (last_used_at).
    // The convenience grant would additionally hand over PutItem, DeleteItem,
    // Scan and both batch APIs across the WHOLE table — every persona, PRD,
    // PR/FAQ and prototype — on the ONE function in this stack that is reachable
    // with a bearer token instead of a Cognito session. The absent actions are
    // what enforce read-only-ness rather than remember it; same reasoning as the
    // ballots role above, and `mcp Lambda IAM grants` in api-stack.test.ts pins
    // the exact set.
    projectsTable.grant(mcpRole, 'dynamodb:Query', 'dynamodb:UpdateItem');
    // EncryptDecrypt, not just Decrypt: the narrow grant above no longer brings
    // the table's KMS permissions along the way grantReadWriteData did, and the
    // last_used_at UpdateItem is a write to a KMS-encrypted table. Same pairing
    // as the ballots role.
    kmsKey.grantEncryptDecrypt(mcpRole);

    const mcpLambda = new lambda.Function(this, 'McpApi', {
      functionName: this.uniqueName('voc-mcp-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'mcp_handler.lambda_handler',
      code: createApiLambdaCode('mcp_handler.py'),
      role: mcpRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        PROJECTS_TABLE: projectsTable.tableName,
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        // NOT used for CORS here (MCP clients are not browsers, the handler
        // answers Access-Control-Allow-Origin: *). It is the allowlist for the
        // MCP spec's DNS-rebinding guard: a request that CARRIES an Origin
        // header naming any other origin is refused 403 before auth runs. A
        // request with no Origin header — every real MCP client — is untouched.
        ALLOWED_ORIGIN: allowedOrigin,
        POWERTOOLS_SERVICE_NAME: 'voc-mcp-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('McpApiLogs', this.uniqueName('voc-mcp-api')),
    });

    const mcpIntegration = new apigateway.LambdaIntegration(mcpLambda, { proxy: true });

    // Inline Node.js token-format authorizer (validates Bearer voc_* shape; mcp_handler does the real check)
    const mcpAuthorizerLogGroup = this.createLogGroup('McpAuthorizerLogs', this.uniqueName('voc-mcp-authorizer'));
    const mcpAuthorizerFn = new lambda.Function(this, 'McpTokenAuthorizer', {
      functionName: this.uniqueName('voc-mcp-token-authorizer'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  const token = event.authorizationToken || '';
  const methodArn = event.methodArn;
  if (!token.startsWith('Bearer voc_') || token.length < 20) {
    throw new Error('Unauthorized');
  }
  const arnParts = methodArn.split(':');
  const region = arnParts[3];
  const accountId = arnParts[4];
  const apiGatewayArnParts = arnParts[5].split('/');
  const restApiId = apiGatewayArnParts[0];
  const stage = apiGatewayArnParts[1];
  const resourceArn = 'arn:aws:execute-api:' + region + ':' + accountId + ':' + restApiId + '/' + stage + '/*/mcp*';
  return {
    principalId: 'mcp-client',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Action: 'execute-api:Invoke',
        Effect: 'Allow',
        Resource: resourceArn,
      }],
    },
  };
};
`),
      timeout: cdk.Duration.seconds(3),
      memorySize: 128,
      logGroup: mcpAuthorizerLogGroup,
    });
    NagSuppressions.addResourceSuppressions(mcpAuthorizerFn, [
      { id: 'AwsSolutions-L1', reason: 'Node.js 22 is the latest LTS runtime available in CDK for inline Lambda authorizers' },
    ], true);

    const mcpTokenAuthorizer = new apigateway.TokenAuthorizer(this, 'McpApiTokenAuthorizer', {
      handler: mcpAuthorizerFn,
      identitySource: 'method.request.header.Authorization',
      resultsCacheTtl: cdk.Duration.seconds(300),
      authorizerName: 'voc-mcp-token-authorizer',
    });

    const mcpMethodOptions: apigateway.MethodOptions = {
      authorizer: mcpTokenAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
    };

    const mcpResource = this.api.root.addResource('mcp');
    const mcpMethod = mcpResource.addMethod('POST', mcpIntegration, mcpMethodOptions);
    const mcpProxy = mcpResource.addProxy({ defaultIntegration: mcpIntegration, anyMethod: true, defaultMethodOptions: mcpMethodOptions });

    // Throttling lives in `deployOptions.methodOptions` at the top of this stack
    // ('/mcp/POST', '/mcp/{proxy+}/POST', '/mcp/{proxy+}/GET'), NOT in a usage
    // plan. The McpUsagePlan
    // that used to sit here never bound: a usage plan's throttle applies per API
    // key, and no MCP client sends one. Do not reintroduce it.

    NagSuppressions.addResourceSuppressions(mcpProxy, [
      { id: 'AwsSolutions-COG4', reason: 'MCP uses a custom Lambda token authorizer instead of Cognito — MCP clients cannot use the Cognito auth flow' },
    ], true);
    NagSuppressions.addResourceSuppressions(mcpMethod, [
      { id: 'AwsSolutions-COG4', reason: 'MCP endpoint uses a custom Lambda token authorizer instead of Cognito — MCP clients cannot use the Cognito auth flow' },
    ]);


    // ============================================
    // FRONTEND DEPLOYMENT
    // ============================================
    // Runtime config.json - loaded by frontend at startup
    // This allows the same build to work across multiple environments
    const runtimeConfig = {
      apiEndpoint: this.api.url,
      cognito: {
        userPoolId: userPool.userPoolId,
        clientId: userPoolClient.userPoolClientId,
        region: this.region,
        identityPoolId: identityPool.attrId
      },
      // Capability flags so the same frontend build can show/hide features
      // per environment (web search only exists when the gateway deployed).
      features: {
        webSearch: webSearch !== undefined,
      },
    };

    const websiteDeployment = new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [
        s3deploy.Source.asset('frontend/dist'),
        s3deploy.Source.data('config.json', JSON.stringify(runtimeConfig, null, 2)),
      ],
      destinationBucket: websiteBucket,
      distribution: frontendDistribution,
      distributionPaths: ['/*'],
    });

    // Suppress CDK custom resource Lambda runtime warnings for BucketDeployment
    // Find and suppress the CDK-managed custom resource (hash-based ID)
    for (const child of this.node.findAll()) {
      if (child.node.id.startsWith('Custom::CDKBucketDeployment')) {
        NagSuppressions.addResourceSuppressions(child, [...cdkCustomResourceSuppressions, ...cdkAssetsSuppressions], true);
      }
    }

    // ============================================
    // OUTPUTS
    // ============================================
    new cdk.CfnOutput(this, 'ApiEndpoint', { value: this.api.url });
    new cdk.CfnOutput(this, 'ApiId', { value: this.api.restApiId });
    new cdk.CfnOutput(this, 'WebhookPlugins', { value: webhookPlugins.map(p => p.id).join(',') });
    new cdk.CfnOutput(this, 'CognitoUserPoolId', { value: userPool.userPoolId, description: 'Cognito User Pool ID' });
    new cdk.CfnOutput(this, 'CognitoClientId', { value: userPoolClient.userPoolClientId, description: 'Cognito User Pool Client ID' });
    new cdk.CfnOutput(this, 'WebSearchAvailable', {
      value: webSearch !== undefined ? 'true' : 'false',
      description: 'Whether the AgentCore web search gateway is deployed (drives the frontend feature flag)',
    });
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  private createLambdaRole(id: string): iam.Role {
    return new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
  }

  private createLogGroup(id: string, name: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName: `/aws/lambda/${name}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }

  /**
   * PRD/PR-FAQ generation state machine. Splits the multi-step LLM chain across
   * Lambda invocations so each step gets its own fresh 15-minute budget — long
   * CJK documents (whose steps auto-continue past maxTokens over several Bedrock
   * calls) no longer overrun a single Lambda. Mirrors the research workflow.
   *
   * Flow: gather → step0 → step1 → step2 → [step3 if PR-FAQ] → save
   * PRD has 3 chain steps, PR-FAQ has 4 — a Choice on num_steps runs the 4th
   * step only for PR-FAQ. Each step's index drives which chain step runs; the
   * step handler reads/writes intermediate text in S3 (claim-check), so SF state
   * carries only scalars. Every LLM step has its own retry on throttling.
   */
  private createDocumentStateMachine(documentStepLambda: lambda.Function): sfn.StateMachine {
    const llmRetry = (t: tasks.LambdaInvoke) => {
      t.addRetry({
        // NOTE: a Lambda hitting ITS OWN configured timeout (as opposed to the
        // Step Functions task's own `States.Timeout`, which is only enforced if
        // a heartbeat/timeout is set on the state itself, which we don't do
        // here) surfaces as `Sandbox.Timedout` — verified live: a 32K-max_tokens
        // prd_document step exhausted the full 900s Lambda budget and the
        // execution history recorded `"error": "Sandbox.Timedout"`, which this
        // list did not previously include, so the retry never engaged and the
        // whole job failed outright instead of getting a fresh 15-minute budget.
        errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout', 'Sandbox.Timedout', 'BedrockThrottlingException'],
        interval: cdk.Duration.seconds(5), maxAttempts: 3, backoffRate: 2,
      });
      return t;
    };

    // gather: build chain steps + context, stash to S3. Returns scalars
    // (doc_type, title, feature_idea, num_steps) used by later states.
    const gather = new tasks.LambdaInvoke(this, 'DocGather', {
      lambdaFunction: documentStepLambda,
      payload: sfn.TaskInput.fromObject({
        step: 'gather',
        'job_id.$': '$.job_id',
        'project_id.$': '$.project_id',
        'doc_config.$': '$.doc_config',
      }),
      resultPath: '$.gathered',
      resultSelector: {
        'doc_type.$': '$.Payload.doc_type',
        'title.$': '$.Payload.title',
        'feature_idea.$': '$.Payload.feature_idea',
        'num_steps.$': '$.Payload.num_steps',
      },
    });

    // One run_step state per fixed index. converse() auto-continues internally.
    const runStep = (index: number) => {
      const t = new tasks.LambdaInvoke(this, `DocStep${index}`, {
        lambdaFunction: documentStepLambda,
        payload: sfn.TaskInput.fromObject({
          step: 'run_step',
          index,
          'job_id.$': '$.job_id',
          'project_id.$': '$.project_id',
        }),
        resultPath: sfn.JsonPath.DISCARD, // output lives in S3; nothing to thread
      });
      return llmRetry(t);
    };

    const save = new tasks.LambdaInvoke(this, 'DocSave', {
      lambdaFunction: documentStepLambda,
      payload: sfn.TaskInput.fromObject({
        step: 'save',
        'job_id.$': '$.job_id',
        'project_id.$': '$.project_id',
        'doc_type.$': '$.gathered.doc_type',
        'title.$': '$.gathered.title',
        'feature_idea.$': '$.gathered.feature_idea',
        'num_steps.$': '$.gathered.num_steps',
      }),
      resultPath: '$.save_result',
    });
    save.addRetry({ errors: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'States.Timeout', 'Sandbox.Timedout'], interval: cdk.Duration.seconds(2), maxAttempts: 3, backoffRate: 2 });

    const handleError = new tasks.LambdaInvoke(this, 'DocHandleError', {
      lambdaFunction: documentStepLambda,
      payload: sfn.TaskInput.fromObject({
        step: 'error',
        'job_id.$': '$.job_id',
        'project_id.$': '$.project_id',
        'error.$': '$.error',
      }),
    });

    const success = new sfn.Succeed(this, 'DocComplete');
    const fail = new sfn.Fail(this, 'DocFailed', { cause: 'Document job failed', error: 'DocumentError' });
    handleError.next(fail);
    // addCatch mutates the state's Catch list, so call it exactly once per state.
    const addCatch = (s: tasks.LambdaInvoke) => s.addCatch(handleError, { resultPath: '$.error' });

    // Attach the error catch to every state ONCE, up front.
    addCatch(gather);
    const s0 = addCatch(runStep(0));
    const s1 = addCatch(runStep(1));
    const s2 = addCatch(runStep(2));
    const s3 = addCatch(runStep(3));
    addCatch(save);
    save.next(success);

    // PR-FAQ has a 4th chain step; PRD stops at 3. Branch on num_steps.
    // Both branches converge on the same (already-catch-wired) save state.
    const maybeStep3 = new sfn.Choice(this, 'NeedsFourthStep')
      .when(sfn.Condition.numberGreaterThan('$.gathered.num_steps', 3),
            s3.next(save))
      .otherwise(save);

    const definition = gather
      .next(s0)
      .next(s1)
      .next(s2)
      .next(maybeStep3);

    return new sfn.StateMachine(this, 'DocumentStateMachine', {
      stateMachineName: this.uniqueName('voc-document-workflow'),
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(2),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, 'DocumentStateMachineLogs', {
          logGroupName: this.uniqueName('/aws/stepfunctions/voc-document-workflow'),
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
      },
    });
  }

  private createWebhookLambda(
    plugin: PluginManifest,
    webhookRole: iam.Role,
    apiLayer: lambda.LayerVersion,
    processingQueueUrl: string,
    feedbackTableName: string,
    secretsArn: string,
    brandName: string
  ): lambda.Function {
    const webhookCode = lambda.Code.fromAsset('plugins', {
      exclude: ['**/__pycache__', '*.pyc', '_template/**'],
      bundling: {
        image: lambda.Runtime.PYTHON_3_14.bundlingImage,
        command: ['bash', '-c', `mkdir -p /asset-output && cp -r /asset-input/${plugin.id}/webhook/* /asset-output/ && cp -r /asset-input/_shared /asset-output/`],
        platform: 'linux/arm64',
      },
    });

    const pascalPluginId = capitalize(plugin.id);

    return new lambda.Function(this, `${pascalPluginId}Webhook`, {
      functionName: this.uniqueName(`voc-webhook-${plugin.id}`),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: webhookCode,
      role: webhookRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        PROCESSING_QUEUE_URL: processingQueueUrl,
        FEEDBACK_TABLE: feedbackTableName,
        SECRETS_ARN: secretsArn,
        BRAND_NAME: brandName,
        PLUGIN_ID: plugin.id,
        POWERTOOLS_SERVICE_NAME: `voc-webhook-${plugin.id}`,
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup(`${pascalPluginId}WebhookLogs`, this.uniqueName(`voc-webhook-${plugin.id}`)),
    });
  }
}
