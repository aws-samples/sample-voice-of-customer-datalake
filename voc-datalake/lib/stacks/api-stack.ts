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
import * as path from 'path';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { loadPlugins, getEnabledPlugins, getPluginsWithWebhook, capitalize, type PluginManifest } from '../plugin-loader';
import { uniqueName } from '../utils/naming';
import { cdkCustomResourceSuppressions, apiGatewayRequestValidationSuppressions, publicFeedbackEndpointSuppressions, pluginSystemSuppressions, cdkAssetsSuppressions, marketplaceSuppressions } from '../utils/nag-suppressions';

export interface VocApiStackProps extends cdk.StackProps {
  // Core stack resources
  feedbackTable: dynamodb.Table;
  aggregatesTable: dynamodb.Table;
  projectsTable: dynamodb.Table;
  jobsTable: dynamodb.Table;
  conversationsTable: dynamodb.Table;
  kmsKey: kms.Key;
  rawDataBucket: s3.Bucket;
  avatarsCdnUrl: string;
  websiteBucket: s3.Bucket;
  frontendDistribution: cloudfront.Distribution;
  frontendDomainName: string;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  identityPool: cognito.CfnIdentityPool;

  // Ingestion stack resources
  processingQueueUrl: string;
  processingQueueArn: string;
  secretsArn: string;
  s3ImportBucket: s3.Bucket;

  // Processing stack resources
  researchStateMachine: sfn.StateMachine;

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
export class VocApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: VocApiStackProps) {
    super(scope, id, props);

    const {
      feedbackTable, aggregatesTable, projectsTable, jobsTable, conversationsTable,
      kmsKey, rawDataBucket, avatarsCdnUrl, websiteBucket, frontendDistribution,
      frontendDomainName, userPool, userPoolClient, identityPool, processingQueueUrl, processingQueueArn,
      secretsArn, s3ImportBucket, researchStateMachine, brandName
    } = props;



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
      code: lambda.Code.fromAsset('lambda/layers/processing-deps', {
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
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          command: [
            'bash', '-c',
            `mkdir -p /asset-output && ` +
            `cp /asset-input/api/${handlerFileName} /asset-output/ && ` +
            `cp -r /asset-input/shared /asset-output/ && ` +
            `if [ -f /asset-input/api/projects.py ]; then cp /asset-input/api/projects.py /asset-output/; fi && ` +
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
      functionName: uniqueName('voc-metrics-api'),
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
      logGroup: this.createLogGroup('MetricsApiLogs', uniqueName('voc-metrics-api')),
    });

    // Integrations API
    const integrationsRole = this.createLambdaRole('IntegrationsLambdaRole');
    integrationsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
      resources: [secretsArn],
    }));
    integrationsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:EnableRule', 'events:DisableRule', 'events:DescribeRule'],
      resources: [`arn:aws:events:${this.region}:${this.account}:rule/voc-ingest-*-schedule*`],
    }));
    integrationsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:voc-ingestor-*`],
    }));
    NagSuppressions.addResourceSuppressions(integrationsRole, pluginSystemSuppressions, true);

    const integrationsLambda = new lambda.Function(this, 'IntegrationsApi', {
      functionName: uniqueName('voc-integrations-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'integrations_handler.lambda_handler',
      code: createApiLambdaCode('integrations_handler.py'),
      role: integrationsRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { SECRETS_ARN: secretsArn, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-integrations-api', LOG_LEVEL: 'INFO', DEPLOY_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID, DEPLOY_REGION: cdk.Aws.REGION, AGGREGATES_TABLE: aggregatesTable.tableName },
      layers: [apiLayer],
      logGroup: this.createLogGroup('IntegrationsApiLogs', uniqueName('voc-integrations-api')),
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
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:voc-ingestor-webscraper-*`],
    }));
    NagSuppressions.addResourceSuppressions(scrapersRole, pluginSystemSuppressions, true);
    scrapersRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
      ],
    }));
    // AWS Marketplace permissions required for Bedrock model access
    scrapersRole.addToPolicy(new iam.PolicyStatement({
      actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
      resources: ['*'],
    }));
    NagSuppressions.addResourceSuppressions(scrapersRole, marketplaceSuppressions, true);

    const scrapersLambda = new lambda.Function(this, 'ScrapersApi', {
      functionName: uniqueName('voc-scrapers-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'scrapers_handler.lambda_handler',
      code: createApiLambdaCode('scrapers_handler.py'),
      role: scrapersRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: { SECRETS_ARN: secretsArn, AGGREGATES_TABLE: aggregatesTable.tableName, WEBSCRAPER_FUNCTION_NAME: uniqueName('voc-ingestor-webscraper'), ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-scrapers-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('ScrapersApiLogs', uniqueName('voc-scrapers-api')),
    });


    // Manual Import API
    const manualImportRole = this.createLambdaRole('ManualImportLambdaRole');
    aggregatesTable.grantReadWriteData(manualImportRole);
    kmsKey.grantEncryptDecrypt(manualImportRole);
    manualImportRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));
    manualImportRole.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [`arn:aws:lambda:${this.region}:${this.account}:function:voc-manual-import-processor-*`] }));
    NagSuppressions.addResourceSuppressions(manualImportRole, pluginSystemSuppressions, true);
    rawDataBucket.grantReadWrite(manualImportRole);

    const manualImportLambda = new lambda.Function(this, 'ManualImportApi', {
      functionName: uniqueName('voc-manual-import-api'),
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
        MANUAL_IMPORT_PROCESSOR_FUNCTION: uniqueName('voc-manual-import-processor'),
        ALLOWED_ORIGIN: allowedOrigin,
        POWERTOOLS_SERVICE_NAME: 'voc-manual-import-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('ManualImportApiLogs', uniqueName('voc-manual-import-api')),
    });

    // Manual Import Processor (async)
    const manualImportProcessorRole = this.createLambdaRole('ManualImportProcessorRole');
    aggregatesTable.grantReadWriteData(manualImportProcessorRole);
    kmsKey.grantEncryptDecrypt(manualImportProcessorRole);
    manualImportProcessorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`, 'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6'],
    }));

    new lambda.Function(this, 'ManualImportProcessor', {
      functionName: uniqueName('voc-manual-import-processor'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'manual_import_processor.lambda_handler',
      code: createApiLambdaCode('manual_import_processor.py'),
      role: manualImportProcessorRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: { AGGREGATES_TABLE: aggregatesTable.tableName, POWERTOOLS_SERVICE_NAME: 'voc-manual-import-processor', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('ManualImportProcessorLogs', uniqueName('voc-manual-import-processor')),
    });

    // Settings API
    const settingsRole = this.createLambdaRole('SettingsLambdaRole');
    aggregatesTable.grantReadWriteData(settingsRole);
    kmsKey.grantEncryptDecrypt(settingsRole);
    settingsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`, 'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6'],
    }));

    const settingsLambda = new lambda.Function(this, 'SettingsApi', {
      functionName: uniqueName('voc-settings-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'settings_handler.lambda_handler',
      code: createApiLambdaCode('settings_handler.py'),
      role: settingsRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { AGGREGATES_TABLE: aggregatesTable.tableName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-settings-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('SettingsApiLogs', uniqueName('voc-settings-api')),
    });

    // Logs API
    const logsRole = this.createLambdaRole('LogsLambdaRole');
    aggregatesTable.grantReadWriteData(logsRole);
    kmsKey.grantDecrypt(logsRole);

    const logsLambda = new lambda.Function(this, 'LogsApi', {
      functionName: uniqueName('voc-logs-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'logs_handler.lambda_handler',
      code: createApiLambdaCode('logs_handler.py'),
      role: logsRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { AGGREGATES_TABLE: aggregatesTable.tableName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-logs-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('LogsApiLogs', uniqueName('voc-logs-api')),
    });

    // Users API
    const usersRole = this.createLambdaRole('UsersLambdaRole');
    usersRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminCreateUser', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup', 'cognito-idp:AdminResetUserPassword', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminDisableUser', 'cognito-idp:AdminDeleteUser', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminUpdateUserAttributes'],
      resources: [userPool.userPoolArn],
    }));

    const usersLambda = new lambda.Function(this, 'UsersApi', {
      functionName: uniqueName('voc-users-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'users_handler.lambda_handler',
      code: createApiLambdaCode('users_handler.py'),
      role: usersRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { USER_POOL_ID: userPool.userPoolId, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-users-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('UsersApiLogs', uniqueName('voc-users-api')),
    });

    // Feedback Form API
    const feedbackFormRole = this.createLambdaRole('FeedbackFormLambdaRole');
    aggregatesTable.grantReadWriteData(feedbackFormRole);
    feedbackTable.grantReadData(feedbackFormRole);
    kmsKey.grantEncryptDecrypt(feedbackFormRole);
    feedbackFormRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));

    const feedbackFormLambda = new lambda.Function(this, 'FeedbackFormApi', {
      functionName: uniqueName('voc-feedback-form-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'feedback_form_handler.lambda_handler',
      code: createApiLambdaCode('feedback_form_handler.py'),
      role: feedbackFormRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { AGGREGATES_TABLE: aggregatesTable.tableName, FEEDBACK_TABLE: feedbackTable.tableName, PROCESSING_QUEUE_URL: processingQueueUrl, BRAND_NAME: brandName, POWERTOOLS_SERVICE_NAME: 'voc-feedback-form-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('FeedbackFormApiLogs', uniqueName('voc-feedback-form-api')),
    });

    // Chat API
    const chatRole = this.createLambdaRole('ChatLambdaRole');
    feedbackTable.grantReadData(chatRole);
    aggregatesTable.grantReadWriteData(chatRole);
    conversationsTable.grantReadWriteData(chatRole);
    kmsKey.grantEncryptDecrypt(chatRole);
    chatRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`, 'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6'],
    }));

    const chatLambda = new lambda.Function(this, 'ChatApi', {
      functionName: uniqueName('voc-chat-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'chat_handler.lambda_handler',
      code: createApiLambdaCode('chat_handler.py'),
      role: chatRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: { FEEDBACK_TABLE: feedbackTable.tableName, AGGREGATES_TABLE: aggregatesTable.tableName, CONVERSATIONS_TABLE: conversationsTable.tableName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-chat-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('ChatApiLogs', uniqueName('voc-chat-api')),
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
        `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
        'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-canvas-v1:0',
      ],
    }));

    rawDataBucket.grantReadWrite(projectsRole, 'avatars/*');

    const projectsLambda = new lambda.Function(this, 'ProjectsApi', {
      functionName: uniqueName('voc-projects-api'),
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
        ALLOWED_ORIGIN: allowedOrigin,
        POWERTOOLS_SERVICE_NAME: 'voc-projects-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('ProjectsApiLogs', uniqueName('voc-projects-api')),
    });

    // ============================================
    // JOB LAMBDAS (Async Background Processing)
    // ============================================

    /**
     * Creates an optimized Lambda code bundle for job handlers.
     * Includes the job handler, shared modules, and api/projects.py for business logic.
     */
    const createJobLambdaCode = (jobFolder: string): lambda.Code => {
      return lambda.Code.fromAsset('lambda', {
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          command: [
            'bash', '-c',
            `mkdir -p /asset-output/api && ` +
            `cp /asset-input/jobs/${jobFolder}/handler.py /asset-output/ && ` +
            `cp -r /asset-input/shared /asset-output/ && ` +
            `cp /asset-input/api/projects.py /asset-output/api/ && ` +
            `cp -r /asset-input/api/prompts /asset-output/prompts`
          ],
          platform: 'linux/arm64',
        },
      });
    };

    // Persona Generator Job Lambda
    const personaGeneratorRole = this.createLambdaRole('PersonaGeneratorRole');
    feedbackTable.grantReadData(personaGeneratorRole);
    projectsTable.grantReadWriteData(personaGeneratorRole);
    jobsTable.grantReadWriteData(personaGeneratorRole);
    aggregatesTable.grantReadData(personaGeneratorRole);
    kmsKey.grantEncryptDecrypt(personaGeneratorRole);
    personaGeneratorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
        'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-canvas-v1:0',
      ],
    }));
    rawDataBucket.grantReadWrite(personaGeneratorRole, 'avatars/*');

    const personaGeneratorLambda = new lambda.Function(this, 'PersonaGeneratorJob', {
      functionName: uniqueName('voc-job-persona-generator'),
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
      logGroup: this.createLogGroup('PersonaGeneratorJobLogs', uniqueName('voc-job-persona-generator')),
    });

    // Document Generator Job Lambda (PRD/PRFAQ)
    const documentGeneratorRole = this.createLambdaRole('DocumentGeneratorRole');
    feedbackTable.grantReadData(documentGeneratorRole);
    projectsTable.grantReadWriteData(documentGeneratorRole);
    jobsTable.grantReadWriteData(documentGeneratorRole);
    kmsKey.grantEncryptDecrypt(documentGeneratorRole);
    documentGeneratorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
      ],
    }));

    const documentGeneratorLambda = new lambda.Function(this, 'DocumentGeneratorJob', {
      functionName: uniqueName('voc-job-document-generator'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: createJobLambdaCode('document_generator'),
      role: documentGeneratorRole,
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
      environment: {
        PROJECTS_TABLE: projectsTable.tableName,
        FEEDBACK_TABLE: feedbackTable.tableName,
        JOBS_TABLE: jobsTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'voc-job-document-generator',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('DocumentGeneratorJobLogs', uniqueName('voc-job-document-generator')),
    });

    // Document Merger Job Lambda
    const documentMergerRole = this.createLambdaRole('DocumentMergerRole');
    feedbackTable.grantReadData(documentMergerRole);
    projectsTable.grantReadWriteData(documentMergerRole);
    jobsTable.grantReadWriteData(documentMergerRole);
    kmsKey.grantEncryptDecrypt(documentMergerRole);
    documentMergerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
      ],
    }));

    const documentMergerLambda = new lambda.Function(this, 'DocumentMergerJob', {
      functionName: uniqueName('voc-job-document-merger'),
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
        JOBS_TABLE: jobsTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'voc-job-document-merger',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('DocumentMergerJobLogs', uniqueName('voc-job-document-merger')),
    });

    // Persona Importer Job Lambda
    const personaImporterRole = this.createLambdaRole('PersonaImporterRole');
    projectsTable.grantReadWriteData(personaImporterRole);
    jobsTable.grantReadWriteData(personaImporterRole);
    kmsKey.grantEncryptDecrypt(personaImporterRole);
    personaImporterRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
        'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-canvas-v1:0',
      ],
    }));
    rawDataBucket.grantReadWrite(personaImporterRole, 'avatars/*');

    const personaImporterLambda = new lambda.Function(this, 'PersonaImporterJob', {
      functionName: uniqueName('voc-job-persona-importer'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: createJobLambdaCode('persona_importer'),
      role: personaImporterRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        PROJECTS_TABLE: projectsTable.tableName,
        JOBS_TABLE: jobsTable.tableName,
        RAW_DATA_BUCKET: rawDataBucket.bucketName,
        AVATARS_CDN_URL: avatarsCdnUrl,
        POWERTOOLS_SERVICE_NAME: 'voc-job-persona-importer',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('PersonaImporterJobLogs', uniqueName('voc-job-persona-importer')),
    });

    // Add job Lambda function names to Projects API environment
    projectsLambda.addEnvironment('PERSONA_GENERATOR_FUNCTION', personaGeneratorLambda.functionName);
    projectsLambda.addEnvironment('DOCUMENT_GENERATOR_FUNCTION', documentGeneratorLambda.functionName);
    projectsLambda.addEnvironment('DOCUMENT_MERGER_FUNCTION', documentMergerLambda.functionName);
    projectsLambda.addEnvironment('PERSONA_IMPORTER_FUNCTION', personaImporterLambda.functionName);

    // Grant Projects API permission to invoke job Lambdas
    personaGeneratorLambda.grantInvoke(projectsRole);
    documentGeneratorLambda.grantInvoke(projectsRole);
    documentMergerLambda.grantInvoke(projectsRole);
    personaImporterLambda.grantInvoke(projectsRole);

    // Chat Stream (Node.js — API Gateway streaming, replaces Python Function URL)
    const chatStreamLambda = new NodejsFunction(this, 'ChatStreamApi', {
      functionName: uniqueName('voc-chat-stream'),
      entry: path.join(__dirname, '../../lambda/stream/src/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: cdk.Duration.minutes(5),
      environment: {
        PROJECTS_TABLE: projectsTable.tableName,
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        BEDROCK_MODEL_ID: 'global.anthropic.claude-sonnet-4-6',
        AVATARS_CDN_URL: avatarsCdnUrl,
        ALLOWED_ORIGIN: allowedOrigin,
      },
      bundling: {
        format: OutputFormat.ESM,
        mainFields: ['module', 'main'],
        externalModules: [
          '@aws-sdk/*',
          '@smithy/*',
        ],
      },
      logGroup: this.createLogGroup('ChatStreamLogs', uniqueName('voc-chat-stream')),
    });

    // Bedrock permissions — ConverseStream
    chatStreamLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
      ],
    }));
    // AWS Marketplace permissions required for Bedrock model access
    chatStreamLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
      resources: ['*'],
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

    NagSuppressions.addResourceSuppressions(chatStreamLambda, [
      { id: 'AwsSolutions-L1', reason: 'Node.js 22 is the target runtime for the streaming Lambda — latest stable LTS' },
    ], true);

    // MCP Server API (public — auth handled by Lambda via Bearer token)
    const mcpRole = this.createLambdaRole('McpLambdaRole');
    feedbackTable.grantReadData(mcpRole);
    aggregatesTable.grantReadData(mcpRole);
    projectsTable.grantReadWriteData(mcpRole);  // read tokens + update last_used_at
    kmsKey.grantDecrypt(mcpRole);

    const mcpLambda = new lambda.Function(this, 'McpApi', {
      functionName: uniqueName('voc-mcp-api'),
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
        POWERTOOLS_SERVICE_NAME: 'voc-mcp-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('McpApiLogs', uniqueName('voc-mcp-api')),
    });

    // S3 Import API
    const s3ImportRole = this.createLambdaRole('S3ImportLambdaRole');
    s3ImportBucket.grantReadWrite(s3ImportRole);
    kmsKey.grantEncryptDecrypt(s3ImportRole);

    const s3ImportLambda = new lambda.Function(this, 'S3ImportApi', {
      functionName: uniqueName('voc-s3-import-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 's3_import_handler.lambda_handler',
      code: createApiLambdaCode('s3_import_handler.py'),
      role: s3ImportRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { S3_IMPORT_BUCKET: s3ImportBucket.bucketName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-s3-import-api', LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: this.createLogGroup('S3ImportApiLogs', uniqueName('voc-s3-import-api')),
    });

    // Data Explorer API
    const dataExplorerRole = this.createLambdaRole('DataExplorerLambdaRole');
    rawDataBucket.grantReadWrite(dataExplorerRole);
    feedbackTable.grantReadWriteData(dataExplorerRole);
    kmsKey.grantEncryptDecrypt(dataExplorerRole);
    dataExplorerRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));

    const dataExplorerLambda = new lambda.Function(this, 'DataExplorerApi', {
      functionName: uniqueName('voc-data-explorer-api'),
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
      logGroup: this.createLogGroup('DataExplorerApiLogs', uniqueName('voc-data-explorer-api')),
    });

    // Chrome Extension API
    const extensionRole = this.createLambdaRole('ExtensionLambdaRole');
    rawDataBucket.grantReadWrite(extensionRole);
    kmsKey.grantEncryptDecrypt(extensionRole);
    extensionRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));

    const extensionLambda = new lambda.Function(this, 'ExtensionApi', {
      functionName: uniqueName('voc-extension-api'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'extension_handler.lambda_handler',
      code: createApiLambdaCode('extension_handler.py'),
      role: extensionRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        RAW_DATA_BUCKET: rawDataBucket.bucketName,
        PROCESSING_QUEUE_URL: processingQueueUrl,
        ALLOWED_ORIGIN: allowedOrigin,
        POWERTOOLS_SERVICE_NAME: 'voc-extension-api',
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup('ExtensionApiLogs', uniqueName('voc-extension-api')),
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
      logGroupName: `/aws/apigateway/${uniqueName('voc-analytics-api')}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.api = new apigateway.RestApi(this, 'VocAnalyticsApi', {
      restApiName: uniqueName('voc-analytics-api'),
      description: 'Voice of the Customer Analytics API v2',
      deployOptions: {
        stageName: 'v1',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
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
    const mcpIntegration = new apigateway.LambdaIntegration(mcpLambda, { proxy: true });
    const extensionIntegration = new apigateway.LambdaIntegration(extensionLambda, { proxy: true });

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

    // /feedback/problems/* (problem resolution)
    const problemsResource = feedbackResource.addResource('problems');
    problemsResource.addResource('resolved').addMethod('GET', metricsIntegration, authMethodOptions);
    const problemIdResource = problemsResource.addResource('{problemId}');
    const problemResolveResource = problemIdResource.addResource('resolve');
    problemResolveResource.addMethod('PUT', metricsIntegration, authMethodOptions);
    problemResolveResource.addMethod('DELETE', metricsIntegration, authMethodOptions);

    // /metrics/*
    const metricsResource = this.api.root.addResource('metrics');
    metricsResource.addResource('summary').addMethod('GET', metricsIntegration, authMethodOptions);
    metricsResource.addResource('sentiment').addMethod('GET', metricsIntegration, authMethodOptions);
    metricsResource.addResource('categories').addMethod('GET', metricsIntegration, authMethodOptions);
    metricsResource.addResource('sources').addMethod('GET', metricsIntegration, authMethodOptions);
    metricsResource.addResource('personas').addMethod('GET', metricsIntegration, authMethodOptions);

    // /chat/*
    const chatResource = this.api.root.addResource('chat');
    chatResource.addMethod('POST', chatIntegration, authMethodOptions);
    const chatStreamResource = chatResource.addResource('stream');
    const chatStreamMethod = chatStreamResource.addMethod('POST', chatStreamIntegration, authMethodOptions);
    chatResource.addResource('conversations').addProxy({ defaultIntegration: chatIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // Apply streaming overrides to /chat/stream
    const chatStreamCfnMethod = chatStreamMethod.node.defaultChild as cdk.aws_apigateway.CfnMethod;
    chatStreamCfnMethod.addPropertyOverride('Integration.ResponseTransferMode', 'STREAM');
    chatStreamCfnMethod.addPropertyOverride('Integration.TimeoutInMillis', 300000);
    chatStreamCfnMethod.addPropertyOverride(
      'Integration.Uri',
      `arn:aws:apigateway:${this.region}:lambda:path/2021-11-15/functions/${chatStreamLambda.functionArn}/response-streaming-invocations`
    );

    // /integrations/*
    const integrationsResource = this.api.root.addResource('integrations');
    integrationsResource.addResource('status').addMethod('GET', integrationsIntegration, authMethodOptions);
    const intSourceResource = integrationsResource.addResource('{source}');
    const intCredentialsResource = intSourceResource.addResource('credentials');
    intCredentialsResource.addMethod('PUT', integrationsIntegration, authMethodOptions);
    intCredentialsResource.addMethod('GET', integrationsIntegration, authMethodOptions);
    intSourceResource.addResource('test').addMethod('POST', integrationsIntegration, authMethodOptions);
    const intAppsResource = intSourceResource.addResource('apps');
    intAppsResource.addMethod('GET', integrationsIntegration, authMethodOptions);
    intAppsResource.addMethod('POST', integrationsIntegration, authMethodOptions);
    intAppsResource.addResource('{appId}').addMethod('DELETE', integrationsIntegration, authMethodOptions);

    // /sources/*
    const sourcesResource = this.api.root.addResource('sources');
    sourcesResource.addResource('status').addMethod('GET', integrationsIntegration, authMethodOptions);
    const srcSourceResource = sourcesResource.addResource('{source}');
    srcSourceResource.addResource('enable').addMethod('PUT', integrationsIntegration, authMethodOptions);
    srcSourceResource.addResource('disable').addMethod('PUT', integrationsIntegration, authMethodOptions);
    const srcRunResource = srcSourceResource.addResource('run');
    srcRunResource.addMethod('POST', integrationsIntegration, authMethodOptions);

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
    scrapersResource.addProxy({ defaultIntegration: scrapersIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // /s3-import/*
    const s3ImportResource = this.api.root.addResource('s3-import');
    s3ImportResource.addResource('files').addMethod('GET', s3ImportIntegration, authMethodOptions);
    const s3SourcesResource = s3ImportResource.addResource('sources');
    s3SourcesResource.addMethod('GET', s3ImportIntegration, authMethodOptions);
    s3SourcesResource.addMethod('POST', s3ImportIntegration, authMethodOptions);
    s3ImportResource.addResource('upload-url').addMethod('POST', s3ImportIntegration, authMethodOptions);
    s3ImportResource.addResource('file').addResource('{key}').addMethod('DELETE', s3ImportIntegration, authMethodOptions);

    // /data-explorer/*
    const dataExplorerResource = this.api.root.addResource('data-explorer');
    const dataExplorerS3Resource = dataExplorerResource.addResource('s3');
    dataExplorerS3Resource.addMethod('GET', dataExplorerIntegration, authMethodOptions);
    dataExplorerS3Resource.addMethod('PUT', dataExplorerIntegration, authMethodOptions);
    dataExplorerS3Resource.addMethod('DELETE', dataExplorerIntegration, authMethodOptions);
    dataExplorerS3Resource.addResource('preview').addMethod('GET', dataExplorerIntegration, authMethodOptions);
    const dataExplorerFeedbackResource = dataExplorerResource.addResource('feedback');
    dataExplorerFeedbackResource.addMethod('PUT', dataExplorerIntegration, authMethodOptions);
    dataExplorerFeedbackResource.addMethod('DELETE', dataExplorerIntegration, authMethodOptions);
    dataExplorerResource.addResource('stats').addMethod('GET', dataExplorerIntegration, authMethodOptions);
    dataExplorerResource.addResource('buckets').addMethod('GET', dataExplorerIntegration, authMethodOptions);

    // /settings/*
    const settingsResource = this.api.root.addResource('settings');
    const brandResource = settingsResource.addResource('brand');
    brandResource.addMethod('GET', settingsIntegration, authMethodOptions);
    brandResource.addMethod('PUT', settingsIntegration, authMethodOptions);
    const settingsCategoriesResource = settingsResource.addResource('categories');
    settingsCategoriesResource.addMethod('GET', settingsIntegration, authMethodOptions);
    settingsCategoriesResource.addMethod('PUT', settingsIntegration, authMethodOptions);
    settingsCategoriesResource.addResource('generate').addMethod('POST', settingsIntegration, authMethodOptions);

    const reviewResource = settingsResource.addResource('review');
    reviewResource.addMethod('GET', settingsIntegration, authMethodOptions);
    reviewResource.addMethod('PUT', settingsIntegration, authMethodOptions);

    // /logs/*
    const logsResource = this.api.root.addResource('logs');
    const logsValidationResource = logsResource.addResource('validation');
    logsValidationResource.addMethod('GET', logsIntegration, authMethodOptions);
    logsValidationResource.addResource('{source}').addMethod('DELETE', logsIntegration, authMethodOptions);
    logsResource.addResource('processing').addMethod('GET', logsIntegration, authMethodOptions);
    logsResource.addResource('summary').addMethod('GET', logsIntegration, authMethodOptions);
    logsResource.addResource('scraper').addResource('{scraper_id}').addMethod('GET', logsIntegration, authMethodOptions);

    // /users/*
    const usersResource = this.api.root.addResource('users');
    usersResource.addMethod('GET', usersIntegration, authMethodOptions);
    usersResource.addMethod('POST', usersIntegration, authMethodOptions);
    usersResource.addProxy({ defaultIntegration: usersIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // /feedback-form/* (legacy single form - public endpoints)
    const feedbackFormResource = this.api.root.addResource('feedback-form');
    const feedbackFormConfigResource = feedbackFormResource.addResource('config');
    const feedbackFormConfigGet = feedbackFormConfigResource.addMethod('GET', feedbackFormIntegration);
    feedbackFormConfigResource.addMethod('PUT', feedbackFormIntegration, authMethodOptions);
    const feedbackFormSubmit = feedbackFormResource.addResource('submit').addMethod('POST', feedbackFormIntegration);
    const feedbackFormEmbed = feedbackFormResource.addResource('embed').addMethod('GET', feedbackFormIntegration);
    const feedbackFormIframe = feedbackFormResource.addResource('iframe').addMethod('GET', feedbackFormIntegration);

    NagSuppressions.addResourceSuppressions(feedbackFormConfigGet, publicFeedbackEndpointSuppressions);
    NagSuppressions.addResourceSuppressions(feedbackFormSubmit, publicFeedbackEndpointSuppressions);
    NagSuppressions.addResourceSuppressions(feedbackFormEmbed, publicFeedbackEndpointSuppressions);
    NagSuppressions.addResourceSuppressions(feedbackFormIframe, publicFeedbackEndpointSuppressions);

    // /feedback-forms/* (multiple forms)
    const feedbackFormsResource = this.api.root.addResource('feedback-forms');
    feedbackFormsResource.addMethod('GET', feedbackFormIntegration, authMethodOptions);
    feedbackFormsResource.addMethod('POST', feedbackFormIntegration, authMethodOptions);
    const feedbackFormsProxy = feedbackFormsResource.addProxy({ defaultIntegration: feedbackFormIntegration, anyMethod: true });
    NagSuppressions.addResourceSuppressions(feedbackFormsProxy, publicFeedbackEndpointSuppressions, true);

    // /projects/*
    const projectsResource = this.api.root.addResource('projects');
    projectsResource.addMethod('GET', projectsIntegration, authMethodOptions);
    projectsResource.addMethod('POST', projectsIntegration, authMethodOptions);
    projectsResource.addProxy({ defaultIntegration: projectsIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

    // /extension/*
    const extensionResource = this.api.root.addResource('extension');
    extensionResource.addResource('reviews').addMethod('POST', extensionIntegration, authMethodOptions);
    extensionResource.addResource('status').addMethod('GET', extensionIntegration, authMethodOptions);

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
    // MCP TOKEN FORMAT AUTHORIZER
    // ============================================
    // Lightweight Lambda authorizer that validates Bearer token format
    // before invoking the main MCP handler. Rejects requests missing
    // "Bearer voc_..." or the X-Project-Id header at the API Gateway
    // level, reducing cold-start costs from invalid/brute-force requests.

    const mcpAuthorizerLogGroup = this.createLogGroup('McpAuthorizerLogs', uniqueName('voc-mcp-authorizer'));

    const mcpAuthorizerFn = new lambda.Function(this, 'McpTokenAuthorizer', {
      functionName: uniqueName('voc-mcp-token-authorizer'),
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

    // /mcp — protected by token format authorizer + per-method throttling
    const mcpResource = this.api.root.addResource('mcp');
    const mcpMethod = mcpResource.addMethod('POST', mcpIntegration, mcpMethodOptions);

    // /mcp/autoseed/{project_id} — same authorizer
    const mcpAutoseedResource = mcpResource.addResource('autoseed');
    const mcpAutoseedProjectResource = mcpAutoseedResource.addResource('{project_id}');
    const autoseedMethod = mcpAutoseedProjectResource.addMethod('GET', mcpIntegration, mcpMethodOptions);

    // Per-method throttling for MCP endpoints (10 req/s, burst 20)
    // Much lower than the global 100 req/s to limit brute-force exposure
    const mcpUsagePlan = this.api.addUsagePlan('McpUsagePlan', {
      name: uniqueName('voc-mcp-throttle'),
      description: 'Throttle MCP endpoints to limit brute-force token attempts',
      throttle: {
        rateLimit: 10,
        burstLimit: 20,
      },
    });
    mcpUsagePlan.addApiStage({
      stage: this.api.deploymentStage,
      throttle: [
        { method: mcpMethod, throttle: { rateLimit: 10, burstLimit: 20 } },
        { method: autoseedMethod, throttle: { rateLimit: 10, burstLimit: 20 } },
      ],
    });

    NagSuppressions.addResourceSuppressions(autoseedMethod, [
      {
        id: 'AwsSolutions-COG4',
        reason: 'MCP autoseed uses a custom Lambda token authorizer instead of Cognito — MCP clients cannot use Cognito auth flow',
      },
    ]);

    NagSuppressions.addResourceSuppressions(mcpMethod, [
      {
        id: 'AwsSolutions-COG4',
        reason: 'MCP endpoint uses a custom Lambda token authorizer instead of Cognito — MCP clients cannot use Cognito auth flow',
      },
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
      functionName: uniqueName(`voc-webhook-${plugin.id}`),
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
      logGroup: this.createLogGroup(`${pascalPluginId}WebhookLogs`, uniqueName(`voc-webhook-${plugin.id}`)),
    });
  }
}
