import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
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
import { getEnabledPlugins, getPluginsWithWebhook, capitalize, pluginDirectoryIds, type PluginManifest } from '../plugin-loader';
import { assertFrontendBuildFresh } from '../utils/assert-frontend-build';
import { cdkCustomResourceSuppressions, cdkAssetsSuppressions } from '../utils/nag-suppressions';
import { imageModelArn } from '../utils/model-allowlist';
import { pythonLayerCode } from '../utils/python-layer-bundling';
import { PII_REDACTION_ENV, piiDetectionStatement } from '../utils/pii-redaction';
import {
  PY_LAMBDA_ASSET_EXCLUDES,
  VERIFICATION_FIXTURE_PROVIDER_ASSET_EXCLUDES,
  WORKER_TREE_ASSET_EXCLUDES,
  rootPluginAssetExcludes,
} from '../utils/lambda-asset-excludes';
import { stringOr } from '../utils/context';
import { VocStack, VocStackProps } from '../utils/voc-stack';
import type { ApiStackContext } from './api-context';
import { createAssistantLambdas } from './api-assistant-lambdas';
import { createDataLambdas } from './api-data-lambdas';
import { createEngagementLambdas } from './api-engagement-lambdas';
import { createVerificationFixtureProvider } from './api-fixture-provider';
import { createApiGateway } from './api-gateway';
import { createJobLambdas } from './api-job-lambdas';
import { createMcpApi } from './api-mcp';
import { createProjectsLambda } from './api-projects-lambda';
import { addApiRoutes } from './api-routes';
import type { GlobalMcp } from './global-mcp';
import { API_ASYNC_FAILURES_QUEUE_BASE_NAME, importApiAsyncFailureQueue } from './dlq-alarms';

export interface VocApiStackProps extends VocStackProps {
  // Core stack resources
  feedbackTable: dynamodb.Table;
  aggregatesTable: dynamodb.Table;
  projectsTable: dynamodb.Table;
  jobsTable: dynamodb.Table;
  conversationsTable: dynamodb.Table;
  /** voc-memory — served by the memory API (docs/memory.md). */
  memoryTable: dynamodb.Table;
  /** voc-agents — served by the agents API (docs/autonomous-agents.md). */
  agentsTable: dynamodb.Table;
  /** `voc/design-integrations` (Figma/GitHub tokens) — settings API only. String for the KMS cycle reason above. */
  designIntegrationsSecretArn: string;
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
  /** voc-agent-run — the agents API starts ("Run now") and stops (cancel) executions. */
  agentRunStateMachine: sfn.StateMachine;
  /** memory-extract queue — the memory API enqueues page imports onto it. */
  memoryExtractQueueUrl: string;
  memoryExtractQueueArn: string;
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
  /** The global MCP endpoint (/mcp/global) and personal token API (/connect/tokens). */
  public readonly globalMcp: GlobalMcp;

  constructor(scope: Construct, id: string, props: VocApiStackProps) {
    super(scope, id, props);

    const {
      feedbackTable, aggregatesTable, kmsKey, rawDataBucket, websiteBucket, frontendDistribution, frontendDomainName,
      userPool, userPoolClient, identityPool, processingQueueUrl, processingQueueArn, secretsArn, brandName,
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
    const environment = stringOr(this.node.tryGetContext('environment'), 'production')
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
      const providerSourceExcludes = handlerFileName === 'verification_fixture_provider.py'
        ? []
        : VERIFICATION_FIXTURE_PROVIDER_ASSET_EXCLUDES;
      return lambda.Code.fromAsset('lambda', {
        // Stages only api/ + shared/ — everything else is hash noise. The
        // provider source affects only its own bundle, not every API Lambda.
        exclude: [
          ...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES,
          ...providerSourceExcludes,
          '/aggregator/',
          '/jobs/',
          '/processor/',
          '/research/',
        ],
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

    const ctx: ApiStackContext = {
      stack: this,
      props,
      allowedOrigin,
      apiLayer,
      apiCode: createApiLambdaCode,
      role: (roleId) => this.createLambdaRole(roleId),
      logGroup: (logGroupId, name) => this.createLogGroup(logGroupId, name),
      uniqueName: (baseName) => this.uniqueName(baseName),
      uniqueNamePattern: (baseNameTemplate) => this.uniqueNamePattern(baseNameTemplate),
      prefixed: (name) => this.prefixed(name),
      prefixOnlyEnv: (entries) => this.prefixOnlyEnv(entries),
      deploymentPrefix: this.deploymentPrefix,
      // Persona avatar image generation (projects API + persona jobs).
      // Single-sourced in model-allowlist.ts so the grant tracks the model
      // through its EOL migration.
      avatarImageModelArn: imageModelArn(),
      // Where a failed or expired async invocation lands (#253). An invocation
      // that dies before it can record its own failure (init error, OOM, the
      // timeout kill, a throttled event that ages out) would otherwise vanish and
      // leave its job row `running` forever. Lambda writes the original event plus
      // the error here, so the loss is recorded and the job id recoverable. The
      // function's own role sends the record; SqsDestination grants it exactly
      // sqs:SendMessage on this queue plus the CMK. The queue is VocCoreStack's
      // (dlq-alarms.ts API_ASYNC_FAILURES_QUEUE_BASE_NAME: resource ceiling).
      asyncFailureDestination: new lambdaDestinations.SqsDestination(importApiAsyncFailureQueue(
        this, 'AsyncInvokeFailures', this.uniqueName(API_ASYNC_FAILURES_QUEUE_BASE_NAME), kmsKey,
      )),
    };

    // ============================================
    // LAMBDA FUNCTIONS (creation order is template order — keep it)
    // ============================================
    const data = createDataLambdas(ctx);
    const engagement = createEngagementLambdas(ctx, { enabledSourcesEnv: data.enabledSourcesEnv });
    const projects = createProjectsLambda(ctx);
    createVerificationFixtureProvider(ctx);
    createJobLambdas(ctx, projects);
    const assistant = createAssistantLambdas(ctx, {
      projectsLambda: projects.projectsLambda,
      metricsLambda: data.metricsLambda,
      feedbackFormLambda: engagement.feedbackFormLambda,
      settingsLambda: data.settingsLambda,
      scrapersLambda: data.scrapersLambda,
    });


    // ============================================
    // WEBHOOKS
    // ============================================
    // allPlugins is loaded once, up where the integrations Lambda needs its
    // secret defaults.
    const enabledPlugins = getEnabledPlugins(data.allPlugins, props.enabledSources);
    const webhookPlugins = getPluginsWithWebhook(enabledPlugins);

    const webhookRole = this.createLambdaRole('WebhookLambdaRole');
    feedbackTable.grantReadWriteData(webhookRole);
    kmsKey.grantEncryptDecrypt(webhookRole);
    webhookRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));
    webhookRole.addToPolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [secretsArn] }));
    // A delivery gets its source's PII policy (profile row in aggregates) before archive + queue.
    aggregatesTable.grant(webhookRole, 'dynamodb:GetItem');
    webhookRole.addToPolicy(piiDetectionStatement());

    const webhookLambdas = new Map<string, lambda.Function>();
    for (const plugin of webhookPlugins) {
      // Each webhook may write only its OWN source's raw-archive prefix, like
      // every other raw/ writer in this stack (the ingestors own the rest).
      rawDataBucket.grantPut(webhookRole, `raw/${plugin.id}/*`);
      const webhookFn = this.createWebhookLambda(plugin, webhookRole, apiLayer, {
        processingQueueUrl, feedbackTableName: feedbackTable.tableName, secretsArn, brandName,
        rawDataBucketName: rawDataBucket.bucketName, aggregatesTableName: aggregatesTable.tableName,
      });
      webhookLambdas.set(plugin.id, webhookFn);
    }


    // ============================================
    // API GATEWAY, ROUTES, MCP
    // ============================================
    const gateway = createApiGateway(ctx, webhookPlugins);
    this.api = gateway.api;
    addApiRoutes(this, gateway, {
      ...data, ...engagement, ...assistant, projectsLambda: projects.projectsLambda, webhookPlugins, webhookLambdas,
    });
    this.globalMcp = createMcpApi(ctx, gateway, {
      metricsLambda: data.metricsLambda,
      projectsLambda: projects.projectsLambda,
      settingsLambda: data.settingsLambda,
      memoryLambda: assistant.memoryLambda,
      agentsLambda: assistant.agentsLambda,
    });
    const { webSearch } = assistant;


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

    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
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


  private createWebhookLambda(
    plugin: PluginManifest,
    webhookRole: iam.Role,
    apiLayer: lambda.LayerVersion,
    env: {
      processingQueueUrl: string;
      feedbackTableName: string;
      secretsArn: string;
      brandName: string;
      rawDataBucketName: string;
      aggregatesTableName: string;
    },
  ): lambda.Function {
    const { processingQueueUrl, feedbackTableName, secretsArn, brandName, rawDataBucketName, aggregatesTableName } = env;
    // Staged from the PROJECT ROOT, exactly like an ingestor bundle
    // (ingestion-stack.ts bundlePluginCode): `_shared/base_webhook.py` imports
    // `shared.aws` / `shared.logging`, which live in lambda/shared. The bundle
    // used to be rooted at plugins/ and copied only `<id>/webhook` + `_shared`,
    // so the first deployed webhook would have died on `No module named 'shared'`
    // — latent while no manifest declared a webhook. Sibling plugins are excluded
    // per id so their edits do not redeploy this function.
    const pluginIds = pluginDirectoryIds(path.join(__dirname, '../../plugins'));
    const webhookCode = lambda.Code.fromAsset('.', {
      exclude: rootPluginAssetExcludes(plugin.id, pluginIds),
      ignoreMode: cdk.IgnoreMode.GIT,
      bundling: {
        image: lambda.Runtime.PYTHON_3_14.bundlingImage,
        command: ['bash', '-c', [
          'mkdir -p /asset-output',
          `cp -r /asset-input/plugins/${plugin.id}/webhook/* /asset-output/`,
          'cp -r /asset-input/plugins/_shared /asset-output/',
          'cp -r /asset-input/lambda/shared /asset-output/',
        ].join(' && ')],
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
        // BOTH names, matching createIngestorLambda in ingestion-stack.ts.
        // `base_webhook.py` reads SOURCE_PLATFORM for the plugin identity it
        // scopes the shared secret by, and since issue #251 an empty identity is
        // a hard ConfigurationError at construction — so with only PLUGIN_ID set
        // every delivery to a deployed webhook would have failed, on a message
        // blaming the identity rather than the missing variable. Latent until a
        // manifest declares `infrastructure.webhook` (none does yet), which is
        // exactly why it would have surfaced as a deploy-time mystery. Pinned by
        // 'SOURCE_PLATFORM' in api-stack-webhook-env.test.ts — that latency is
        // also why it needs its own file: api-stack.test.ts's fixtures read the
        // real manifests and so synthesize no webhook Lambda to assert against.
        SOURCE_PLATFORM: plugin.id,
        PLUGIN_ID: plugin.id,
        // The raw archive (`raw/<plugin_id>/…`), written by `_shared/raw_archive.py`
        // like every ingestor's; the role may put only under this plugin's prefix.
        RAW_DATA_BUCKET: rawDataBucketName,
        // Source profile (PII policy, retention) — shared/source_profiles.py.
        AGGREGATES_TABLE: aggregatesTableName,
        ...PII_REDACTION_ENV,
        POWERTOOLS_SERVICE_NAME: `voc-webhook-${plugin.id}`,
        LOG_LEVEL: 'INFO',
      },
      layers: [apiLayer],
      logGroup: this.createLogGroup(`${pascalPluginId}WebhookLogs`, this.uniqueName(`voc-webhook-${plugin.id}`)),
    });
  }
}
