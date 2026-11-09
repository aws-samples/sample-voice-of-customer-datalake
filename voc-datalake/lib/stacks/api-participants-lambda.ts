/**
 * VocApiStack's engagement API: ONE Lambda, `voc-engagement-api` (lambda/api/engagement_handler.py),
 * serving the participants routes (/participants/*, the public POST /unsubscribe) and the
 * feature-request board (/feature-requests/*). One function, not two, for the stack's resource
 * budget and because both domains write the participants table (a board "promote" creates people
 * and a list).
 *
 * `POST /participants/asks` records the ask and its recipients, then async-invokes THIS function by
 * name (`{"engagement_job": "send_ask", …}`); each invocation sends a slice and re-invokes itself
 * with the next cursor. So the function carries the async failure destination (#253) and no retry
 * — a hidden re-drive could email a recipient twice. Creating or editing a board request async-invokes
 * it the same way (`{"engagement_job": "enrich_feature_request", …}`) for the request's enrichment.
 *
 * Resources are created on the stack itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { grantClaudeModels } from '../utils/claude-model-grant';
import { emailSenderOf, type EmailSender } from '../utils/email-sender';
import { appVersion } from '../utils/connector-version';
import type { ApiStackContext } from './api-context';
import { functionArnByName } from './api-assist-workers';

/** Base physical name (before `uniqueName()`); also its POWERTOOLS_SERVICE_NAME. */
const ENGAGEMENT_API_FUNCTION_BASE_NAME = 'voc-engagement-api';

/** API Gateway still cuts the REST path at 29 s; the self-invoked send slices get the full minute. */
const ENGAGEMENT_TIMEOUT = cdk.Duration.seconds(60);

/** DynamoDB and SES at ≤ 10/s; 512 MB reached 98.6 % CPU p95 on 2026-11-09, one step up (lib/sizing/policy.ts). */
const ENGAGEMENT_MEMORY_MB = 1024;

/** A queued send continuation older than this is dropped to the failure destination. */
const ENGAGEMENT_MAX_EVENT_AGE = cdk.Duration.hours(1);

/**
 * `ses:SendEmail` from exactly the configured address. SES authorizes against the identity it
 * sends with: the domain identity the operator verifies, or the address identity when that one is
 * verified as well (SES prefers the more specific), so both ARNs are named. `ses:FromAddress`
 * pins the From whichever identity applies.
 */
function sesSendStatement(stack: cdk.Stack, sender: EmailSender): iam.PolicyStatement {
  const identityArn = (identity: string) => stack.formatArn({
    service: 'ses', resource: 'identity', resourceName: identity, arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
  return new iam.PolicyStatement({
    actions: ['ses:SendEmail'],
    resources: [identityArn(sender.domain), identityArn(sender.address)],
    conditions: { StringEquals: { 'ses:FromAddress': sender.address } },
  });
}

export function createParticipantsLambda(ctx: ApiStackContext): lambda.Function {
  const { stack, allowedOrigin, apiLayer, apiCode } = ctx;
  const {
    participantsTable, featureRequestsTable, projectsTable, aggregatesTable, kmsKey, userPool, boardUserPool,
    frontendDomainName, rawDataBucket,
  } = ctx.props;
  const sender = emailSenderOf(stack.node);
  const functionName = ctx.uniqueName(ENGAGEMENT_API_FUNCTION_BASE_NAME);

  const role = ctx.role('EngagementLambdaRole');
  // Its own two tables, read and written (the gsi1 listings included).
  participantsTable.grantReadWriteData(role);
  featureRequestsTable.grantReadWriteData(role);
  // shared/project_access.py: the project META and its members (view / edit checks).
  projectsTable.grantReadData(role);
  // The brand name (default sender name), the categories config and the model picker (the board requests'
  // enrichment, lambda/shared/feature_requests_enrich.py): single items, no index.
  role.addToPolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [aggregatesTable.tableArn] }));
  kmsKey.grantEncryptDecrypt(role);
  // The board requests' enrichment: one `enrichment`-surface Converse call per request, on whichever allowlisted
  // model the picker or a capacity fallback lands on (the stack's shared managed policies: no new resource).
  grantClaudeModels(role, 'invoke');
  // The boards' raw copies (lambda/shared/feature_requests_raw.py): write-once versions of each request
  // and +1, under the feature_requests prefix only. No read, no delete.
  rawDataBucket.grantPut(role, 'raw/feature_requests/*');
  if (sender !== undefined) role.addToPolicy(sesSendStatement(stack, sender));
  // The send continuation invokes this function by NAME: grantInvoke() would make the role's
  // policy depend on the function that depends on the role.
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [functionArnByName(ctx, functionName)],
  }));

  return new lambda.Function(stack, 'EngagementApi', {
    functionName,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'engagement_handler.lambda_handler',
    code: apiCode('engagement_handler.py'),
    role,
    timeout: ENGAGEMENT_TIMEOUT,
    memorySize: ENGAGEMENT_MEMORY_MB,
    retryAttempts: 0,
    maxEventAge: ENGAGEMENT_MAX_EVENT_AGE,
    onFailure: ctx.asyncFailureDestination,
    environment: {
      PARTICIPANTS_TABLE: participantsTable.tableName,
      FEATURE_REQUESTS_TABLE: featureRequestsTable.tableName,
      PROJECTS_TABLE: projectsTable.tableName,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      // The boards' raw copies and their connector-version (lambda/shared/feature_requests_raw.py).
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      APP_VERSION: appVersion(),
      // '' = email sending off (POST /participants/asks answers 409 email_not_configured).
      EMAIL_FROM: sender?.address ?? '',
      FRONTEND_URL: `https://${frontendDomainName}`,
      APP_USER_POOL_ID: userPool.userPoolId,
      // The board pool exists on every deployment since 5.45.00 (core-board-auth.ts).
      BOARD_USER_POOL_ID: boardUserPool.userPoolId,
      ENGAGEMENT_FUNCTION: functionName,
      ALLOWED_ORIGIN: allowedOrigin,
      POWERTOOLS_SERVICE_NAME: ENGAGEMENT_API_FUNCTION_BASE_NAME,
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('EngagementApiLogs', functionName),
  });
}
