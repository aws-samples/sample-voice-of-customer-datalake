/**
 * `voc-design-capture` (VocIngestionStack): reads ONE live website's design in the AWS-managed
 * AgentCore browser for a `website` design reference (docs/company-context.md). The settings API
 * (VocApiStack) starts it by async invoke of its deterministic name (DESIGN_CAPTURE_FUNCTION).
 *
 * Its own least-privilege role:
 * - the managed browser (Start/Stop on aws.browser.v1, the stream connect on `*`), as web_reviews;
 * - bedrock:InvokeModel on the curated allowlist (the vision call on the utility surface);
 * - voc-aggregates GetItem on the design-system and model-settings partitions only, UpdateItem on the
 *   design-system partition only (`dynamodb:LeadingKeys`), and KMS for the table;
 * - s3:PutObject on the raw bucket's `company-context/design/logo_preview_*` keys only (the logo
 *   candidate's preview, downloaded through the SSRF-guarded fetch; no read, no delete, no other prefix);
 * - nothing else: no secrets, no queue.
 *
 * The bundle is the worker (lambda/design_capture), the three web_reviews browser modules flat beside
 * it, plugins/_shared (agentcore_browser logs through it) and lambda/shared; the ingestion layer carries
 * websocket-client. Resources are created on the stack itself (logical ids `DesignCapture*`).
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { stackModelArns } from '../utils/model-allowlist';
import { bedrockModelSuppressions } from '../utils/nag-suppressions';
import { rootPluginAssetExcludes } from '../utils/lambda-asset-excludes';
import { pythonLambdaAsset } from '../utils/python-lambda-asset';
import { DESIGN_CAPTURE_FUNCTION_BASE_NAME } from '../utils/function-names';
import { BROWSER_STREAM_SUPPRESSION, managedBrowserStatements } from './ingestion-roles';

/** The aggregates partitions the worker reads (shared/company_context.py, shared/model_config.py). */
export const DESIGN_SYSTEM_PARTITION = 'SETTINGS#design_system';
export const MODEL_SETTINGS_PARTITION = 'SETTINGS#model';
/** Where a logo candidate's preview is stored (shared/extracted_design.py LOGO_PREVIEW_PREFIX). */
export const LOGO_PREVIEW_PREFIX = 'company-context/design/logo_preview_';
/** One page and one vision call; the browser session itself is capped at 120 s in the worker. */
export const DESIGN_CAPTURE_TIMEOUT = cdk.Duration.minutes(5);
export const DESIGN_CAPTURE_MEMORY_MB = 512;
/** The web_reviews modules the worker reuses (copied flat beside it). */
const REUSED_BROWSER_MODULES = ['agentcore_browser.py', 'cdp_client.py', 'block_detection.py'];
const OWN_TREE_EXCLUDE = '/lambda/design_capture/';
const BROWSER_PLUGIN = 'web_reviews';

export interface DesignCaptureProps {
  aggregatesTable: dynamodb.ITable;
  rawDataBucket: s3.IBucket;
  kmsKey: kms.IKey;
  layer: lambda.ILayerVersion;
  allPluginIds: string[];
  functionName: string;
  logGroupName: string;
}

function designCaptureCode(allPluginIds: string[]): lambda.Code {
  const ingestor = `/asset-input/plugins/${BROWSER_PLUGIN}/ingestor`;
  return pythonLambdaAsset('.', {
    exclude: rootPluginAssetExcludes(BROWSER_PLUGIN, allPluginIds).filter((pattern) => pattern !== OWN_TREE_EXCLUDE),
    copy: [
      'mkdir -p /asset-output',
      // The worker's own test_*.py files match this glob too; the prune drops them.
      'cp /asset-input/lambda/design_capture/*.py /asset-output/',
      ...REUSED_BROWSER_MODULES.map((module) => `cp ${ingestor}/${module} /asset-output/`),
      'cp -r /asset-input/plugins/_shared /asset-output/',
      'cp -r /asset-input/lambda/shared /asset-output/',
    ],
  });
}

function designCaptureRole(stack: cdk.Stack, props: DesignCaptureProps): iam.Role {
  const { aggregatesTable, kmsKey, rawDataBucket } = props;
  const role = new iam.Role(stack, 'DesignCaptureRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
  });
  for (const statement of managedBrowserStatements(stack)) role.addToPolicy(statement);
  role.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: stackModelArns(stack) }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'ReadDesignAndModelSettings',
    actions: ['dynamodb:GetItem'],
    resources: [aggregatesTable.tableArn],
    conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [DESIGN_SYSTEM_PARTITION, MODEL_SETTINGS_PARTITION] } },
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'RecordDesignReferenceOutcome',
    actions: ['dynamodb:UpdateItem'],
    resources: [aggregatesTable.tableArn],
    conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [DESIGN_SYSTEM_PARTITION] } },
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'StoreLogoCandidatePreview',
    actions: ['s3:PutObject'],
    resources: [rawDataBucket.arnForObjects(`${LOGO_PREVIEW_PREFIX}*`)],
  }));
  kmsKey.grantEncryptDecrypt(role);
  NagSuppressions.addResourceSuppressions(role, [BROWSER_STREAM_SUPPRESSION, ...bedrockModelSuppressions], true);
  return role;
}

export function createDesignCapture(stack: cdk.Stack, props: DesignCaptureProps): lambda.Function {
  const { aggregatesTable, rawDataBucket, layer, allPluginIds, functionName, logGroupName } = props;
  return new lambda.Function(stack, 'DesignCapture', {
    functionName,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'capture_handler.lambda_handler',
    code: designCaptureCode(allPluginIds),
    role: designCaptureRole(stack, props),
    timeout: DESIGN_CAPTURE_TIMEOUT,
    memorySize: DESIGN_CAPTURE_MEMORY_MB,
    // A retry would open another billed browser session; the outcome is recorded on the reference.
    retryAttempts: 0,
    maxEventAge: cdk.Duration.hours(1),
    environment: {
      AGGREGATES_TABLE: aggregatesTable.tableName,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      POWERTOOLS_SERVICE_NAME: DESIGN_CAPTURE_FUNCTION_BASE_NAME,
      LOG_LEVEL: 'INFO',
    },
    layers: [layer],
    logGroup: new logs.LogGroup(stack, 'DesignCaptureLogs', {
      logGroupName,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });
}
