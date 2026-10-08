import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { pluginSystemSuppressions } from '../utils/nag-suppressions';
import { stackModelArns } from '../utils/model-allowlist';
import { pythonLayerCode } from '../utils/python-layer-bundling';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { VocStack, VocStackProps } from '../utils/voc-stack';
import { MEMORY_EXTRACT_DLQ_BASE_NAME, MemoryWorkers } from './memory-workers';
import { ALARM_TOPIC_BASE_NAME, addQueueDepthAlarm, importAlarmTopic } from './dlq-alarms';
import { AgentRuntime } from './agent-runtime';
import { RetentionWorker } from './retention-worker';
import { createResearchStateMachine } from './processing-research-workflow';

export interface VocProcessingStackProps extends VocStackProps {
  feedbackTable: dynamodb.Table;
  aggregatesTable: dynamodb.Table;
  projectsTable: dynamodb.Table;
  jobsTable: dynamodb.Table;
  idempotencyTable: dynamodb.Table;
  /** voc-memory — memory items, events, session cursors, imports. */
  memoryTable: dynamodb.Table;
  /** voc-agents — agents, workflows, runs, run events, crewmate transcripts. */
  agentsTable: dynamodb.Table;
  /** The memory scanner reads assistant sessions; the extractor reads one. */
  conversationsTable: dynamodb.Table;
  processingQueue: sqs.Queue;
  kmsKey: kms.Key;
  /** Raw data lake — the category reprocess worker re-reads `raw/*` in raw mode. */
  rawDataBucket: s3.IBucket;
  // Web search (AgentCore Gateway, deployed in us-east-1 by VocWebSearchStack)
  // — absent when the feature isn't enabled.
  webSearchGatewayUrl?: string;
  webSearchGatewayArn?: string;
  webSearchToolName?: string;
  config: {
    brandName: string;
    primaryLanguage: string;
    enabledSources: string[];
  };
}

/**
 * Base physical name of the category reprocess worker. The settings API (in
 * VocApiStack) builds the same deterministic name for its env var and invoke
 * grant instead of importing the function: no cross-stack export to pin, and
 * the API stack already deploys after this one.
 */
export const CATEGORY_REPROCESS_FUNCTION_BASE_NAME = 'voc-category-reprocess';

// Feedback processor event source. Pinned by processing-stack-consolidated.test.ts.
const PROCESSOR_BATCHING_WINDOW_SECONDS = 5;
const PROCESSOR_ENRICHMENT_CONCURRENCY = 5;

/**
 * VocProcessingStack - Consolidated processing and research
 * 
 * Merges: VocProcessingStack + VocResearchStack
 * 
 * Contains:
 * - Feedback processor Lambda (SQS triggered)
 * - Aggregation Lambda (DynamoDB Streams triggered)
 * - Research Step Functions workflow
 * - Research step Lambda
 * - Category reprocess worker (async job started by POST /settings/categories/reprocess)
 * - Retention / erasure worker, voc-retention (daily + POST /settings/erasure; retention-worker.ts)
 * - Memory workers: scanner, memory-extract queue + extractor, retention (memory-workers.ts)
 * - Autonomous-agent runtime: heartbeat, conductor, persona panel, voc-agent-run (agent-runtime.ts)
 */
export class VocProcessingStack extends VocStack {
  public readonly processingLambda: lambda.Function;
  public readonly aggregationLambda: lambda.Function;
  public readonly researchStateMachine: sfn.StateMachine;
  public readonly categoryReprocessLambda: lambda.Function;
  /** voc-retention — per-source retention + erasure (the only customer-data delete). */
  public readonly retentionLambda: lambda.Function;
  /** Memory extraction queue — the memory API (imports) sends to it from VocApiStack. */
  public readonly memoryExtractQueue: sqs.Queue;
  /** voc-agent-run — the agents API starts/stops executions from VocApiStack. */
  public readonly agentRunStateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: VocProcessingStackProps) {
    super(scope, id, props);

    const { feedbackTable, aggregatesTable, projectsTable, jobsTable, idempotencyTable, processingQueue, kmsKey, rawDataBucket, config } = props;


    // Shared Lambda Layer
    const processingLayer = new lambda.LayerVersion(this, 'ProcessingDepsLayer', {
      code: pythonLayerCode('lambda/layers/processing-deps'),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_14],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'Dependencies for processing lambdas (ARM64/Graviton)',
    });

    // ============================================
    // PROCESSING ROLE (shared for processor + aggregator)
    // ============================================
    const processingRole = new iam.Role(this, 'ProcessingLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Bedrock permissions
    // Enrichment defaults to Haiku but admins can repoint the 'enrichment'
    // surface via the picker, so grant every allowlisted model (issue #96).
    processingRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: stackModelArns(this),
    }));

    // Comprehend + Translate permissions
    processingRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ComprehendAnalysis',
      actions: ['comprehend:DetectSentiment', 'comprehend:DetectKeyPhrases', 'comprehend:DetectDominantLanguage'],
      resources: ['*'],
    }));
    processingRole.addToPolicy(new iam.PolicyStatement({
      sid: 'TranslateText',
      actions: ['translate:TranslateText'],
      resources: ['*'],
    }));

    // DynamoDB + KMS permissions
    feedbackTable.grantReadWriteData(processingRole);
    aggregatesTable.grantReadWriteData(processingRole);
    projectsTable.grantReadData(processingRole);
    idempotencyTable.grantReadWriteData(processingRole);
    processingQueue.grantConsumeMessages(processingRole);
    kmsKey.grantEncryptDecrypt(processingRole);

    // ============================================
    // FEEDBACK PROCESSOR LAMBDA
    // ============================================
    const processorCode = lambda.Code.fromAsset('lambda', {
      exclude: [...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES, '/aggregator/', '/api/', '/jobs/', '/research/'],
      ignoreMode: cdk.IgnoreMode.GIT,
      bundling: {
        image: lambda.Runtime.PYTHON_3_14.bundlingImage,
        command: ['bash', '-c', 'mkdir -p /asset-output && cp -r /asset-input/processor/* /asset-output/ && cp -r /asset-input/shared /asset-output/'],
        platform: 'linux/arm64',
      },
    });

    this.processingLambda = new lambda.Function(this, 'FeedbackProcessor', {
      functionName: this.uniqueName('voc-feedback-processor'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: processorCode,
      role: processingRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        FEEDBACK_TABLE: feedbackTable.tableName,
        AGGREGATES_TABLE: aggregatesTable.tableName,
        PROJECTS_TABLE: projectsTable.tableName,
        IDEMPOTENCY_TABLE: idempotencyTable.tableName,
        PRIMARY_LANGUAGE: config.primaryLanguage,
        ENRICHMENT_CONCURRENCY: String(PROCESSOR_ENRICHMENT_CONCURRENCY),
        // No BEDROCK_MODEL_ID env: the enrichment model resolves through the
        // per-surface AI-model picker (lambda/shared/model_config.py — the
        // 'enrichment' surface defaults to Haiku, admins can override it).
        POWERTOOLS_SERVICE_NAME: 'voc-processor',
        POWERTOOLS_IDEMPOTENCY_DISABLED: '0',
        LOG_LEVEL: 'INFO',
      },
      layers: [processingLayer],
      logGroup: new logs.LogGroup(this, 'ProcessorLogs', {
        logGroupName: this.uniqueName('/aws/lambda/voc-feedback-processor'),
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Latency to "visible" is batching window + the batch's enrichment time. The
    // window used to be 30 s, which was most of a Manual Import's ~50 s wait (QA
    // 2.13.00); 5 s still gathers a burst into one invocation. Records of a batch
    // are enriched ENRICHMENT_CONCURRENCY at a time (lambda/processor/handler.py).
    this.processingLambda.addEventSource(new lambdaEventSources.SqsEventSource(processingQueue, {
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(PROCESSOR_BATCHING_WINDOW_SECONDS),
      reportBatchItemFailures: true,
    }));


    // ============================================
    // AGGREGATION LAMBDA
    // ============================================
    const aggregatorCode = lambda.Code.fromAsset('lambda', {
      exclude: [...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES, '/api/', '/jobs/', '/processor/', '/research/'],
      ignoreMode: cdk.IgnoreMode.GIT,
      bundling: {
        image: lambda.Runtime.PYTHON_3_14.bundlingImage,
        command: ['bash', '-c', 'mkdir -p /asset-output && cp -r /asset-input/aggregator/* /asset-output/ && cp -r /asset-input/shared /asset-output/'],
        platform: 'linux/arm64',
      },
    });

    this.aggregationLambda = new lambda.Function(this, 'AggregationProcessor', {
      functionName: this.uniqueName('voc-aggregation-processor'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: aggregatorCode,
      role: processingRole,
      timeout: cdk.Duration.minutes(1),
      memorySize: 512,
      environment: {
        AGGREGATES_TABLE: aggregatesTable.tableName,
        // The dedupe marker for one stream record (issue #264). Streams deliver
        // at-least-once and this event source sets `retryAttempts: 3` with
        // `reportBatchItemFailures: true`, so a batch that partially fails
        // re-presents records whose counter updates (one per dimension, plus the
        // running average) already landed — permanently, since nothing recomputes a
        // counter from source. The aggregator claims each record's `eventID` in this
        // table INSIDE the same TransactWriteItems as the counters, so the claim and
        // the counters commit together or not at all.
        //
        // The shared `processingRole` is already granted this table
        // (`idempotencyTable.grantReadWriteData` above, for the processor), so this
        // is an environment change alone: without the NAME the function cannot
        // reach a table it already has permission on. Absent, the handler logs a
        // warning and applies counters non-transactionally, which is the
        // pre-#264 behaviour rather than an outage.
        IDEMPOTENCY_TABLE: idempotencyTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'voc-aggregator',
        LOG_LEVEL: 'INFO',
      },
      layers: [processingLayer],
      logGroup: new logs.LogGroup(this, 'AggregatorLogs', {
        logGroupName: this.uniqueName('/aws/lambda/voc-aggregation-processor'),
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Records the stream source gives up on (#253): after `retryAttempts` the
    // batch's failed range is otherwise DROPPED, and a feedback item's counters
    // then never reach the aggregates table. The on-failure destination keeps a
    // pointer to each discarded shard range (shard id + sequence numbers, not the
    // record bodies) so the gap is visible and can be replayed from the stream
    // within its 24 h retention. CMK-encrypted, TLS-only, 14 days like the app's
    // other terminal-failure queues; nothing consumes it, hence no DLQ of its own.
    const aggregatorFailureQueueName = this.uniqueName('voc-aggregator-stream-failures');
    const aggregatorFailureQueue = new sqs.Queue(this, 'AggregatorStreamFailures', {
      queueName: aggregatorFailureQueueName,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    NagSuppressions.addResourceSuppressions(aggregatorFailureQueue, [{
      id: 'AwsSolutions-SQS3',
      reason: 'This queue IS the terminal failure record (a DynamoDB stream event source on-failure destination); nothing consumes it, so it has no DLQ of its own',
    }]);
    const alarmTopic = importAlarmTopic(this, 'OpsAlarmTopic', this.uniqueName(ALARM_TOPIC_BASE_NAME));
    addQueueDepthAlarm(this, 'AggregatorStreamFailuresDepthAlarm', { queueName: aggregatorFailureQueueName, topic: alarmTopic });

    this.aggregationLambda.addEventSource(new lambdaEventSources.DynamoEventSource(feedbackTable, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      maxBatchingWindow: cdk.Duration.seconds(30),
      retryAttempts: 3,
      reportBatchItemFailures: true,
      onFailure: new lambdaEventSources.SqsDlq(aggregatorFailureQueue),
    }));

    // ============================================
    // CATEGORY REPROCESS WORKER
    // ============================================
    this.categoryReprocessLambda = this.createCategoryReprocessLambda({
      feedbackTable, aggregatesTable, kmsKey, rawDataBucket, processingLayer, primaryLanguage: config.primaryLanguage,
    });

    // ============================================
    // RETENTION / ERASURE WORKER (docs/source-policies.md)
    // ============================================
    this.retentionLambda = new RetentionWorker(this, 'RetentionWorker', {
      uniqueName: (baseName) => this.uniqueName(baseName),
      layer: processingLayer,
      kmsKey,
      feedbackTable,
      aggregatesTable,
      rawDataBucket,
    }).fn;

    // ============================================
    // MEMORY + AUTONOMOUS AGENTS
    // ============================================
    const uniqueName = (baseName: string) => this.uniqueName(baseName);
    const memoryWorkers = new MemoryWorkers(this, 'MemoryWorkers', {
      uniqueName,
      layer: processingLayer,
      kmsKey,
      memoryTable: props.memoryTable,
      conversationsTable: props.conversationsTable,
      aggregatesTable,
      rawDataBucket,
    });
    this.memoryExtractQueue = memoryWorkers.extractQueue;
    addQueueDepthAlarm(this, 'MemoryExtractDLQDepthAlarm', {
      queueName: this.uniqueName(MEMORY_EXTRACT_DLQ_BASE_NAME), topic: alarmTopic,
    });
    const agentRuntime = new AgentRuntime(this, 'AgentRuntime', {
      uniqueName,
      layer: processingLayer,
      kmsKey,
      agentsTable: props.agentsTable,
      feedbackTable,
      aggregatesTable,
      rawDataBucket,
      memoryExtractQueue: this.memoryExtractQueue,
    });
    this.agentRunStateMachine = agentRuntime.stateMachine;
    NagSuppressions.addResourceSuppressions(this.agentRunStateMachine, pluginSystemSuppressions(this.deploymentPrefix), true);

    // ============================================
    // RESEARCH WORKFLOW (Step Functions)
    // ============================================
    const researchRole = new iam.Role(this, 'ResearchLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    feedbackTable.grantReadData(researchRole);
    projectsTable.grantReadWriteData(researchRole);
    jobsTable.grantReadWriteData(researchRole);
    aggregatesTable.grantReadData(researchRole);
    kmsKey.grantEncryptDecrypt(researchRole);

    // Research is a 'documents' surface (defaults to Sonnet 5) and is
    // repointable via the picker, so grant every allowlisted model (issue #96).
    researchRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: stackModelArns(this),
    }));

    // Same lambda/-rooted staging as processor/aggregator: root-based staging
    // hashed the entire CDK project (scripts/, schemas/, coverage output...)
    // into this asset, redeploying it on every unrelated edit.
    const researchCode = lambda.Code.fromAsset('lambda', {
      // research_step_handler reads api/prompts/research-analysis.json at RUNTIME,
      // so the prompts must be BOTH copied into the bundle (the cp below) and kept
      // in the asset FINGERPRINT (this per-entry exclude) — otherwise editing the
      // config would not change the hash and the Lambda would keep the old budgets.
      // Only prompts are re-included, so api/*.py edits can't churn this hash.
      exclude: [
        ...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES,
        '/aggregator/',
        '/api/*',
        '!/api/prompts',
        '/jobs/',
        '/processor/',
      ],
      ignoreMode: cdk.IgnoreMode.GIT,
      bundling: {
        image: lambda.Runtime.PYTHON_3_14.bundlingImage,
        // INVARIANT: prompts land at the bundle ROOT (/var/task/prompts) —
        // shared/prompts.py::get_prompts_dir resolves that path first. Same
        // staging contract as the api-stack bundles.
        command: ['bash', '-c', 'mkdir -p /asset-output && cp -r /asset-input/research/* /asset-output/ && cp -r /asset-input/shared /asset-output/ && cp -r /asset-input/api/prompts /asset-output/prompts'],
        platform: 'linux/arm64',
      },
    });

    const researchStepLambda = new lambda.Function(this, 'ResearchStepLambda', {
      functionName: this.uniqueName('voc-research-step'),
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'research_step_handler.lambda_handler',
      code: researchCode,
      role: researchRole,
      timeout: cdk.Duration.minutes(15),
      // 1536 MB, raised for CPU (lib/sizing/policy.ts RAISED_FOR_CPU).
      memorySize: 1536,
      environment: {
        FEEDBACK_TABLE: feedbackTable.tableName,
        PROJECTS_TABLE: projectsTable.tableName,
        JOBS_TABLE: jobsTable.tableName,
        // Needed so the per-surface AI-model picker ('documents') can resolve
        // an admin override for research generation (issue #96).
        AGGREGATES_TABLE: aggregatesTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'voc-research-step',
        LOG_LEVEL: 'INFO',
      },
      layers: [processingLayer],
      logGroup: new logs.LogGroup(this, 'ResearchStepLogs', {
        logGroupName: this.uniqueName('/aws/lambda/voc-research-step'),
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Step Functions workflow
    this.researchStateMachine = createResearchStateMachine(this, (baseName) => this.uniqueName(baseName), researchStepLambda);
    NagSuppressions.addResourceSuppressions(this.researchStateMachine, pluginSystemSuppressions(this.deploymentPrefix), true);

    // ============================================
    // WEB SEARCH (AgentCore Gateway — see VocWebSearchStack)
    // ============================================
    // Opt-in per research request; without the gateway the env vars stay
    // unset and step_initialize skips web grounding.
    const { webSearchGatewayUrl, webSearchGatewayArn, webSearchToolName } = props;
    if (webSearchGatewayUrl && webSearchGatewayArn && webSearchToolName) {
      researchStepLambda.addEnvironment('WEB_SEARCH_GATEWAY_URL', webSearchGatewayUrl);
      researchStepLambda.addEnvironment('WEB_SEARCH_TOOL_NAME', webSearchToolName);
      researchStepLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeGateway'],
        resources: [webSearchGatewayArn],
      }));
    }

    // ============================================
    // OUTPUTS
    // ============================================
    new cdk.CfnOutput(this, 'ProcessorFunctionArn', { value: this.processingLambda.functionArn });
    new cdk.CfnOutput(this, 'AggregatorFunctionArn', { value: this.aggregationLambda.functionArn });
    new cdk.CfnOutput(this, 'ResearchStateMachineArn', { value: this.researchStateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'ResearchStepLambdaArn', { value: researchStepLambda.functionArn });
    new cdk.CfnOutput(this, 'AgentRunStateMachineArn', { value: this.agentRunStateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'MemoryExtractQueueUrl', { value: this.memoryExtractQueue.queueUrl });
  }

  /**
   * The category reprocess worker: re-categorises stored feedback in place after
   * the category configuration changes (lambda/jobs/category_reprocess). Scans
   * voc-feedback page by page, checkpoints the job row in aggregates, and hands
   * over to a fresh async invocation of ITSELF before its 15-minute ceiling.
   *
   * Least privilege — no DeleteItem/PutItem on feedback (items are only ever
   * UPDATEd in place), raw bucket read limited to `raw/*`.
   */
  private createCategoryReprocessLambda(deps: {
    feedbackTable: dynamodb.Table;
    aggregatesTable: dynamodb.Table;
    kmsKey: kms.Key;
    rawDataBucket: s3.IBucket;
    processingLayer: lambda.ILayerVersion;
    primaryLanguage: string;
  }): lambda.Function {
    const functionName = this.uniqueName(CATEGORY_REPROCESS_FUNCTION_BASE_NAME);
    const role = new iam.Role(this, 'CategoryReprocessRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    deps.feedbackTable.grant(role, 'dynamodb:Scan', 'dynamodb:GetItem', 'dynamodb:UpdateItem');
    // Category config + model-picker override (GetItem); the job row and its
    // lock are only ever UPDATEd by the worker (claim, checkpoint, finish,
    // release). Creating jobs (PutItem) and the latest-job lookup (Query) are
    // the settings API's, not the worker's.
    deps.aggregatesTable.grant(role, 'dynamodb:GetItem', 'dynamodb:UpdateItem');
    deps.rawDataBucket.grantRead(role, 'raw/*');
    deps.kmsKey.grantEncryptDecrypt(role);
    // 'enrichment'/'utilities' surfaces are repointable via the picker (issue #96).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      actions: ['bedrock:InvokeModel'],
      resources: stackModelArns(this),
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ComprehendAnalysis',
      actions: ['comprehend:DetectSentiment', 'comprehend:DetectDominantLanguage'],
      resources: ['*'],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'TranslateText',
      actions: ['translate:TranslateText'],
      resources: ['*'],
    }));
    // Self hand-over: a deterministic ARN, not `fn.grantInvoke(role)` — the
    // function depends on its role, so a role policy GetAtt-ing the function
    // would be a CloudFormation cycle (same pattern as the api-stack job Lambdas).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'SelfInvoke',
      actions: ['lambda:InvokeFunction'],
      resources: [this.formatArn({ service: 'lambda', resource: 'function', resourceName: functionName, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })],
    }));

    const code = lambda.Code.fromAsset('lambda', {
      exclude: [...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES, '/aggregator/', '/api/', '/processor/', '/research/', '/jobs/retention/'],
      ignoreMode: cdk.IgnoreMode.GIT,
      bundling: {
        image: lambda.Runtime.PYTHON_3_14.bundlingImage,
        command: ['bash', '-c', 'mkdir -p /asset-output && cp /asset-input/jobs/category_reprocess/handler.py /asset-output/ && cp -r /asset-input/shared /asset-output/'],
        platform: 'linux/arm64',
      },
    });

    return new lambda.Function(this, 'CategoryReprocessWorker', {
      functionName,
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code,
      role,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      // Async-invoked; a hidden re-drive would re-pay a page of model calls and
      // race the checkpoint. The job row records failures for the UI instead.
      retryAttempts: 0,
      environment: {
        FEEDBACK_TABLE: deps.feedbackTable.tableName,
        AGGREGATES_TABLE: deps.aggregatesTable.tableName,
        RAW_DATA_BUCKET: deps.rawDataBucket.bucketName,
        PRIMARY_LANGUAGE: deps.primaryLanguage,
        POWERTOOLS_SERVICE_NAME: CATEGORY_REPROCESS_FUNCTION_BASE_NAME,
        LOG_LEVEL: 'INFO',
      },
      layers: [deps.processingLayer],
      logGroup: new logs.LogGroup(this, 'CategoryReprocessLogs', {
        logGroupName: this.uniqueName(`/aws/lambda/${CATEGORY_REPROCESS_FUNCTION_BASE_NAME}`),
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
  }
}
