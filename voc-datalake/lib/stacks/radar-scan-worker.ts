/**
 * The Radar release scan, `voc-radar-scan` (VocProcessingStack, docs/radar.md;
 * handler lambda/jobs/radar_scan/handler.py).
 *
 * Runs on a DAILY tick and on "Scan now" (async invoke by the Radar API). The
 * tick is free when nothing is due: the handler returns after one settings
 * read unless a source profile names a Radar brand and the cadence in
 * Settings -> Radar has elapsed. Results come only from OUR web-search gateway;
 * no competitor site is crawled.
 *
 * Least privilege:
 *   - voc-radar: GetItem / PutItem / Query (release records, scan state, the lock;
 *     no Update, no Delete — the lock is released by expiring it);
 *   - aggregates: GetItem (source profiles, our brand name, the model picker);
 *   - Bedrock: the allowlisted text models ('utilities' surface) + the Titan embedder;
 *   - bedrock-agentcore:InvokeGateway on the web-search gateway, when deployed;
 *   - ssm:GetParameter on exactly the Exa key parameter (`lib/utils/radar-exa-parameter.ts`), read
 *     decrypted when an admin stored a key (no KMS grant: the AWS-managed aws/ssm key).
 * Its feeds are fetched through the SSRF-guarded opener; Exa is called at api.exa.ai.
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { RADAR_SCAN_FUNCTION_BASE_NAME } from '../utils/function-names';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { pythonLambdaAsset } from '../utils/python-lambda-asset';
import { grantCacheVersionBump, RADAR_VERSION_PARTITION } from '../utils/cache-version-grants';
import { embeddingModelArn, stackModelArns } from '../utils/model-allowlist';
import { radarExaParameterName, radarExaParameterStatement } from '../utils/radar-exa-parameter';
import { scheduleWorker, workerRole } from '../utils/worker-lambda';

export interface RadarScanWorkerProps {
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  radarTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
  /** The deployment prefix (the Exa key parameter's name). */
  deploymentPrefix: string | undefined;
  /** The AgentCore web-search gateway; without it (and without Exa or feeds) a scan records `web_search_unavailable`. */
  webSearch?: { url: string; arn: string; toolName: string };
}

/** Only `jobs/radar_scan`, `jobs/__init__.py` and `shared/` reach this bundle (and its hash). */
function radarScanCode(): lambda.Code {
  return pythonLambdaAsset('lambda', {
    exclude: [
      '/jobs/*', '!/jobs/__init__.py', '!/jobs/radar_scan/',
      '/aggregator/', '/api/', '/processor/', '/research/',
      ...WORKER_TREE_ASSET_EXCLUDES, ...PY_LAMBDA_ASSET_EXCLUDES,
    ],
    copy: [
      'mkdir -p /asset-output/jobs',
      'cp /asset-input/jobs/__init__.py /asset-output/jobs/',
      'cp -r /asset-input/jobs/radar_scan /asset-output/jobs/',
      'cp -r /asset-input/shared /asset-output/',
    ],
  });
}

export function createRadarScanWorker(scope: Construct, id: string, props: RadarScanWorkerProps): void {
  // A plain construct with the same id keeps every logical id the class form had.
  const worker = new Construct(scope, id);
  const { uniqueName, kmsKey, radarTable, aggregatesTable, webSearch } = props;
  const functionName = uniqueName(RADAR_SCAN_FUNCTION_BASE_NAME);
  const { region } = cdk.Stack.of(worker);

  const role = workerRole(worker, 'RadarScanRole');
  // 'utilities' surface (release extraction, repointable via the picker) + the Titan embedder (dedupe).
  const models = [...stackModelArns(worker), embeddingModelArn(region)];
  role.addToPolicy(new iam.PolicyStatement({ sid: 'BedrockInvoke', actions: ['bedrock:InvokeModel'], resources: models }));
  radarTable.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query');
  // The Radar version bump after the scan records its outcome (docs/caching.md).
  grantCacheVersionBump(radarTable, role, RADAR_VERSION_PARTITION);
  aggregatesTable.grant(role, 'dynamodb:GetItem');
  kmsKey.grantEncryptDecrypt(role);
  role.addToPolicy(radarExaParameterStatement(cdk.Stack.of(worker), props.deploymentPrefix, ['ssm:GetParameter']));

  const environment: Record<string, string> = {
    RADAR_TABLE: radarTable.tableName,
    AGGREGATES_TABLE: aggregatesTable.tableName,
    RADAR_EXA_PARAMETER: radarExaParameterName(props.deploymentPrefix),
    POWERTOOLS_SERVICE_NAME: RADAR_SCAN_FUNCTION_BASE_NAME,
    LOG_LEVEL: 'INFO',
  };
  if (webSearch) {
    environment.WEB_SEARCH_GATEWAY_URL = webSearch.url;
    environment.WEB_SEARCH_TOOL_NAME = webSearch.toolName;
    role.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock-agentcore:InvokeGateway'], resources: [webSearch.arn] }));
  }

  const fn = new lambda.Function(worker, 'RadarScan', {
    functionName,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'jobs/radar_scan/handler.lambda_handler',
    code: radarScanCode(),
    role,
    timeout: cdk.Duration.minutes(15),
    memorySize: 512,
    // A hidden re-drive would re-pay the searches and model calls; the next tick catches up.
    retryAttempts: 0,
    environment,
    layers: [props.layer],
    logGroup: new logs.LogGroup(worker, 'RadarScanLogs', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });

  // 05:45 UTC daily; the handler decides whether the cadence (daily / weekly / monthly) is due.
  scheduleWorker(worker, 'RadarScanSchedule', fn, uniqueName('voc-radar-scan-schedule'),
    events.Schedule.cron({ hour: '5', minute: '45' }),
    events.RuleTargetInput.fromObject({ mode: 'scheduled' }));
}
