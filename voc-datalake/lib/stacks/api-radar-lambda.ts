/**
 * The Radar API, `voc-radar-api` (VocApiStack, docs/radar.md; handler
 * lambda/api/radar_handler.py): /radar and /radar/{proxy+}.
 *
 * Built ON the stack (stable logical id `RadarApi…`, like every api-*.ts builder).
 * Its own role:
 *   - voc-radar: GetItem / Query (brands' counters, reviews, releases, scan
 *     state) + PutItem (Settings -> Radar only; the handler gates it to admins);
 *   - aggregates: GetItem / Query (source profiles = the brands, category access
 *     and config, and OUR per-category counters for the comparison);
 *   - lambda:InvokeFunction on `voc-radar-scan` by name ("Scan now", admin);
 *   - ssm:PutParameter / DeleteParameter / GetParameter on exactly the Exa key parameter
 *     (`lib/utils/radar-exa-parameter.ts`; PUT / DELETE /radar/settings/exa-key, admin; GET reads it
 *     WITHOUT decryption for `exa_configured`);
 *   - the read cache (docs/caching.md): BatchGetItem on both tables (one call reads
 *     the data/config/Radar versions) and UpdateItem on the `SETTINGS#radar` partition
 *     only (the Radar version bump after a brand-list or settings save).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { RADAR_API_FUNCTION_BASE_NAME, RADAR_SCAN_FUNCTION_BASE_NAME } from '../utils/function-names';
import { grantCacheVersionBump, RADAR_VERSION_PARTITION } from '../utils/cache-version-grants';
import { radarExaParameterName, radarExaParameterStatement } from '../utils/radar-exa-parameter';
import type { ApiStackContext } from './api-context';

export function createRadarLambda(ctx: ApiStackContext): lambda.Function {
  const { stack, allowedOrigin, apiLayer, apiCode, deploymentPrefix } = ctx;
  const { radarTable, aggregatesTable, kmsKey } = ctx.props;
  const scanFunctionName = ctx.uniqueName(RADAR_SCAN_FUNCTION_BASE_NAME);

  const role = ctx.role('RadarLambdaRole');
  radarTable.grant(role, 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:BatchGetItem');
  aggregatesTable.grant(role, 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchGetItem');
  grantCacheVersionBump(radarTable, role, RADAR_VERSION_PARTITION);
  kmsKey.grantEncryptDecrypt(role);
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [stack.formatArn({
      service: 'lambda', resource: 'function', resourceName: scanFunctionName, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    })],
  }));
  role.addToPolicy(radarExaParameterStatement(stack, deploymentPrefix,
    ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:GetParameter']));

  return new lambda.Function(stack, 'RadarApi', {
    functionName: ctx.uniqueName(RADAR_API_FUNCTION_BASE_NAME),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'radar_handler.lambda_handler',
    code: apiCode('radar_handler.py'),
    role,
    timeout: cdk.Duration.seconds(30),
    memorySize: 1769, // one vCPU 2026-10-23: single-threaded Python gains nothing above it (lib/sizing/policy.ts)
    environment: {
      RADAR_TABLE: radarTable.tableName,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      RADAR_SCAN_FUNCTION: scanFunctionName,
      RADAR_EXA_PARAMETER: radarExaParameterName(deploymentPrefix),
      ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: RADAR_API_FUNCTION_BASE_NAME,
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('RadarApiLogs', ctx.uniqueName(RADAR_API_FUNCTION_BASE_NAME)),
  });
}
