/**
 * VocApiStack's people-facing API Lambdas: logs, users, feedback forms (the
 * embeddable widget), anonymous ballots and chat sessions.
 * Resources are created on the stack itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { getEnabledPlugins, loadPlugins } from '../plugin-loader';
import { snapStartFunctionProps } from '../utils/snapstart';
import { PII_REDACTION_ENV, piiDetectionStatement } from '../utils/pii-redaction';
import { FEEDBACK_FORM_API_FUNCTION_BASE_NAME, USERS_API_FUNCTION_BASE_NAME } from '../utils/function-names';
import { AGGREGATES_VERSION_PARTITION, grantCacheVersionBump } from '../utils/cache-version-grants';
import { appVersion } from '../utils/connector-version';
import { grantKeyScopedWrites, grantReadAndWrites } from '../utils/table-write-grants';
import { grantRequestWorkspace, grantWorkspaceMembershipReads } from '../utils/workspace-resolution-grants';
import { WORKSPACE_ID_PATTERN, WORKSPACE_RAW_LAYER_PREFIX } from './core-buckets';
import type { ApiStackContext } from './api-context';
import { OPS_ALERTS_NAG_REASON, opsAlertsWiring } from './dlq-alarms';
import { grantLogsDiagnostics } from './api-logs-diagnostics';

export interface EngagementLambdas {
  logsLambda: lambda.Function;
  usersLambda: lambda.Function;
  feedbackFormLambda: lambda.Function;
  ballotsLambda: lambda.Function;
  chatLambda: lambda.Function;
}

/** What the engagement Lambdas take from the data builder (see `DataLambdas`). */
export interface EngagementInputs {
  enabledSourcesEnv: string;
}

/** The chat API Lambda's timeout (voc-chat-api, lambda/api/chat_handler.py): a chat route's write lands within it of
 *  its fresh workspace resolution, so the workspace hard delete's fence depends on it (docs/multi-workspace.md,
 *  "Export and delete", step 4: the fence is above it plus CHAT_STREAM_TIMEOUT and a margin). */
export const CHAT_API_TIMEOUT = cdk.Duration.seconds(30);

/** A membership's two rows (lambda/shared/workspace_members.py): `WS#{ws}` / `MEMBER#{sub}` and `USER#{sub}` / `WS#{ws}`. */
const MEMBERSHIP_PARTITIONS = ['USER#*', 'WS#*'];
/** A workspace's audit partition, the only one the users API writes in voc-workspaces (lib/utils/audit-row-guard.ts). */
const WORKSPACE_AUDIT_PARTITION = 'AUDIT#WS#*';

/** A workspace form's lookup row in voc-workspaces (lambda/shared/workspace_routing.py): `FORM#{form id}` / `META`. */
const FORM_LOOKUP_PARTITION = 'FORM#*';

/**
 * The feedback forms API in a workspace (docs/multi-workspace.md, "Public and non-user entry points"): the signed-in
 * routes resolve X-Workspace-Id through the stack's one workspace-resolution policy (lib/utils/workspace-resolution-
 * grants.ts: GetItem on `WS#*` and `AUDIT#WS#*`, PutItem on `AUDIT#WS#*` only, which also covers a workspace form's
 * `form_deleted` audit row; and the live platform-admin check), and a workspace's form has a lookup row `FORM#{id}` the
 * public routes read (GetItem), its create writes (a conditional PutItem) and its delete removes (a conditional
 * DeleteItem): `dynamodb:LeadingKeys` `FORM#*` for those three, nothing else of the table (no Query, Scan or
 * UpdateItem). The row is routing configuration, not customer data (lib/customer-data-deletes.test.ts names it).
 */
function grantFormRouting(ctx: ApiStackContext, role: iam.Role): Record<string, string> {
  const { workspacesTable, userPool } = ctx.props;
  const resolutionEnv = grantRequestWorkspace(workspacesTable, role, userPool);
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem'], resources: [workspacesTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [FORM_LOOKUP_PARTITION] } },
  }));
  grantKeyScopedWrites(workspacesTable, role, ['PutItem', 'DeleteItem'], [FORM_LOOKUP_PARTITION]);
  return resolutionEnv;
}

/**
 * DELETE /users/{username} also removes the user's workspace memberships (lambda/shared/workspace_members.py
 * plan_user_removal, remove_user_memberships), so the users API reaches voc-workspaces in these keys only
 * (`dynamodb:LeadingKeys`): Query on `USER#*` (the user's workspaces) and `WS#*` (another admin of a workspace);
 * GetItem on `WS#*` (the user's MEMBER# role) and `AUDIT#WS#*` (an audit row read back after a retried put); PutItem on
 * `AUDIT#WS#*` (each removal's audit row, written first; the audit-row guard names this role a writer of that
 * partition only); DeleteItem on `USER#*` and `WS#*` (the two rows; IAM cannot pin a sort key, so `META` in `WS#*` is
 * in reach of IAM and kept out by the code, which deletes MEMBER# keys only); ConditionCheckItem on `WS#*` (the other
 * admin still is one). No Scan, no UpdateItem, no BatchWriteItem.
 */
function grantDeletedUserMemberships(ctx: ApiStackContext, role: iam.Role): void {
  const { workspacesTable } = ctx.props;
  const scoped = (actions: string[], partitions: string[]) => new iam.PolicyStatement({
    actions, resources: [workspacesTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions } },
  });
  role.addToPolicy(scoped(['dynamodb:Query'], MEMBERSHIP_PARTITIONS));
  role.addToPolicy(scoped(['dynamodb:GetItem'], [WORKSPACE_AUDIT_PARTITION, 'WS#*']));
  role.addToPolicy(scoped(['dynamodb:ConditionCheckItem'], ['WS#*']));
  grantKeyScopedWrites(workspacesTable, role, ['PutItem'], [WORKSPACE_AUDIT_PARTITION]);
  grantKeyScopedWrites(workspacesTable, role, ['DeleteItem'], MEMBERSHIP_PARTITIONS);
}

export function createEngagementLambdas(ctx: ApiStackContext, inputs: EngagementInputs): EngagementLambdas {
  const { stack, allowedOrigin, apiLayer, apiCode: createApiLambdaCode } = ctx;
  const {
    feedbackTable, aggregatesTable, projectsTable, conversationsTable, kmsKey, userPool, processingQueueUrl,
    processingQueueArn, brandName, participantsTable, rawDataBucket,
  } = ctx.props;

  // Logs API — also runs alerting (Settings → Logs → Alerts): it creates and
  // deletes the CloudWatch alarms at runtime and manages the topic's email
  // recipients, so it gets the alert targets by name and exact-resource grants.
  const logsRole = ctx.role('LogsLambdaRole');
  // Alert settings (UpdateItem, shared/ops_alerts_service.py); DELETE /logs/validation/{source} clears that
  // source's LOGS#validation#<source> rows with one batch (BatchWriteItem), nothing else.
  grantReadAndWrites(aggregatesTable, logsRole, ['UpdateItem']);
  grantKeyScopedWrites(aggregatesTable, logsRole, ['BatchWriteItem'], ['LOGS#validation#*']);
  kmsKey.grantDecrypt(logsRole);
  const opsAlerts = opsAlertsWiring({
    stack,
    uniqueName: ctx.uniqueName,
    enabledPlugins: getEnabledPlugins(loadPlugins(path.join(__dirname, '../../plugins')), ctx.props.enabledSources),
  });
  for (const statement of opsAlerts.statements) logsRole.addToPolicy(statement);
  acknowledgeNag(logsRole, [{
    id: 'AwsSolutions-IAM5',
    reason: OPS_ALERTS_NAG_REASON,
    // The prefixed write grant, and cloudwatch:DescribeAlarms (read-only list call, authorized against alarm:*).
    findings: opsAlerts.alarmArns.map(resourceFinding),
  }]);

  // The alert writes are a platform admin's (alarms on the deployment's own Lambdas, docs/multi-workspace.md): the
  // live check reads the caller's groups and account (lambda/shared/platform_admin_gate.py).
  userPool.grant(logsRole, 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminGetUser');

  // Administration → System → Logs diagnostics: log search, failure-queue peek (api-logs-diagnostics.ts).
  const diagnosticsEnv = grantLogsDiagnostics(ctx, logsRole, {
    opsAlertsQueues: opsAlerts.environment.OPS_ALERTS_QUEUES ?? '',
    // A plain string (the stack's name), not a token: no cross-stack reference.
    coreStackName: cdk.Stack.of(userPool).stackName,
  });

  const logsLambda = new lambda.Function(stack, 'LogsApi', {
    functionName: ctx.uniqueName('voc-logs-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'logs_handler.lambda_handler',
    code: createApiLambdaCode('logs_handler.py'),
    role: logsRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 1769, // one vCPU 2026-10-23: single-threaded Python gains nothing above it (lib/sizing/policy.ts)
    environment: { AGGREGATES_TABLE: aggregatesTable.tableName, USER_POOL_ID: userPool.userPoolId, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-logs-api', LOG_LEVEL: 'INFO', ENABLED_SOURCES: inputs.enabledSourcesEnv, ...diagnosticsEnv, WEB_SEARCH_ENABLED: ctx.props.webSearchGatewayUrl !== undefined ? 'true' : 'false', ...opsAlerts.environment },
    layers: [apiLayer],
    logGroup: ctx.logGroup('LogsApiLogs', ctx.uniqueName('voc-logs-api')),
  });

  // Users API
  const usersRole = ctx.role('UsersLambdaRole');
  // ListGroups + ListUsersInGroup: GET /users reads memberships per group
  // (a constant few calls) instead of AdminListGroupsForUser per user (E2E F10).
  usersRole.addToPolicy(new iam.PolicyStatement({
    actions: ['cognito-idp:ListUsers', 'cognito-idp:ListGroups', 'cognito-idp:ListUsersInGroup', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:AdminCreateUser', 'cognito-idp:AdminUpdateUserAttributes', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup', 'cognito-idp:AdminResetUserPassword', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminDisableUser', 'cognito-idp:AdminDeleteUser'],
    resources: [userPool.userPoolArn],
  }));
  // Per-user category access rows (CATEGORY_ACCESS / USER#{sub}) live in
  // aggregates: read and write one item. BatchGetItem: the user list reads
  // every listed user's USERFLAGS row in one call (shared/user_flags.py). PutItem also writes the
  // AUDIT#platform-admins rows of a platform-admin grant or revoke, the one audit partition the audit-row guard
  // lets this role put (lib/utils/audit-row-guard.ts); GetItem reads one back after a retried put.
  // The platform-admin route needs no new Cognito action: AdminAddUserToGroup, AdminRemoveUserFromGroup,
  // AdminListGroupsForUser and ListUsersInGroup are in the statement above.
  aggregatesTable.grant(usersRole, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:BatchGetItem');
  // The config_version bump after a category-access save (docs/caching.md).
  grantCacheVersionBump(aggregatesTable, usersRole, AGGREGATES_VERSION_PARTITION);
  grantDeletedUserMemberships(ctx, usersRole);
  kmsKey.grantEncryptDecrypt(usersRole);

  const usersLambda = new lambda.Function(stack, 'UsersApi', {
    functionName: ctx.uniqueName(USERS_API_FUNCTION_BASE_NAME),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'users_handler.lambda_handler',
    code: createApiLambdaCode('users_handler.py'),
    role: usersRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 512, // CPU: 63.2 % p95 at 256 MB, 2026-10-18 (lib/sizing/policy.ts)
    environment: { USER_POOL_ID: userPool.userPoolId, AGGREGATES_TABLE: aggregatesTable.tableName, WORKSPACES_TABLE: ctx.props.workspacesTable.tableName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-users-api', LOG_LEVEL: 'INFO' },
    layers: [apiLayer],
    logGroup: ctx.logGroup('UsersApiLogs', ctx.uniqueName('voc-users-api')),
  });

  // Feedback Form API
  const feedbackFormRole = ctx.role('FeedbackFormLambdaRole');
  // Form configs and submissions (Put + Update); DELETE /feedback-forms/{id} deletes the FEEDBACK_FORM / FORM#<id>
  // config row (a workspace's: WS#{one id}#FEEDBACK_FORM / FORM#<id>), the only delete.
  grantReadAndWrites(aggregatesTable, feedbackFormRole, ['PutItem', 'UpdateItem']);
  grantKeyScopedWrites(aggregatesTable, feedbackFormRole, ['DeleteItem'], [
    'FEEDBACK_FORM', `WS#${WORKSPACE_ID_PATTERN}#FEEDBACK_FORM`]);
  const formRoutingEnv = grantFormRouting(ctx, feedbackFormRole);
  feedbackTable.grantReadData(feedbackFormRole);
  kmsKey.grantEncryptDecrypt(feedbackFormRole);
  feedbackFormRole.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [processingQueueArn] }));
  // A submission gets its source's PII policy before it is queued.
  feedbackFormRole.addToPolicy(piiDetectionStatement());
  // The submission as the widget sent it (lambda/shared/feedback_form_raw.py): write-once, under the
  // feedback_form source's own prefix only (the source id is fixed, not per form). No read, no delete.
  rawDataBucket.grantPut(feedbackFormRole, 'raw/feedback_form/*');
  // A workspace's form keeps its copy under that workspace's bronze layer (one workspace id per pattern).
  rawDataBucket.grantPut(feedbackFormRole, `${WORKSPACE_RAW_LAYER_PREFIX}feedback_form/*`);
  // Participant attribution (lambda/api/feedback_form_participants.py): a submit carrying an ask's
  // response token reads that token row and marks the recipient (and the ask's count) responded.
  // Two single-item actions on the table itself — no index, no query, no delete.
  feedbackFormRole.addToPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
    resources: [participantsTable.tableArn],
  }));

  const feedbackFormLambda = new lambda.Function(stack, 'FeedbackFormApi', {
    ...snapStartFunctionProps(stack), // GET /feedback-forms cold start (lib/utils/snapstart.ts)
    functionName: ctx.uniqueName(FEEDBACK_FORM_API_FUNCTION_BASE_NAME),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'feedback_form_handler.lambda_handler',
    code: createApiLambdaCode('feedback_form_handler.py'),
    role: feedbackFormRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 1024, // CPU-bound: 512 MB breached 70 % (3.00.00 capacity, lib/sizing/policy.ts)
    environment: {
      AGGREGATES_TABLE: aggregatesTable.tableName,
      FEEDBACK_TABLE: feedbackTable.tableName,
      PROCESSING_QUEUE_URL: processingQueueUrl,
      PARTICIPANTS_TABLE: participantsTable.tableName,
      BRAND_NAME: brandName,
      // X-Workspace-Id on the signed-in routes, and a workspace form's FORM#{id} lookup row (voc-workspaces).
      ...formRoutingEnv,
      // The raw copy of each submission and its connector-version (lambda/shared/feedback_form_raw.py).
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      APP_VERSION: appVersion(),
      ...PII_REDACTION_ENV,
      // '*', DELIBERATELY, and the one Lambda in this stack that gets it rather
      // than `allowedOrigin`. The three public routes below
      // (/feedback-forms/{form_id}/config, /submit, /iframe) are fetched by
      // lambda/api/static/feedback-widget.js running on the CUSTOMER's own site,
      // so the Origin the browser sends is a domain this stack has never heard
      // of and cannot enumerate. Any single value here would break every embed.
      //
      // Stated HERE rather than left to the handler's own
      // `os.environ.get('ALLOWED_ORIGIN', '*')` fallback: the effective value was
      // already '*', but it arrived from a Python default, so a reader of this
      // stack saw an omission where 14 other Lambdas name the variable. This
      // makes the wildcard a recorded decision. Compare the ballots Lambda
      // below, whose comment records the opposite choice for the same reason.
      //
      // The permissiveness is bounded by the ROUTES, not by this variable: every
      // other route on this function carries the Cognito authorizer and is
      // refused before the handler runs, and a CORS header never grants access
      // to a caller that is not a browser anyway.
      //
      // TWO CONSEQUENCES, both deliberate and both out of scope to fix here:
      //
      // 1. This is the ONE Lambda in this stack whose CORS origin is
      //    INDEPENDENT OF THE `environment` CONTEXT. Every other API Lambda
      //    takes `allowedOrigin`, which is `isDev ? '*' : https://<frontend>`
      //    (see its declaration above), so `-c environment=dev` moves all of
      //    them and has no effect whatsoever on this one. Nothing at deploy
      //    time can tighten this value; changing it means editing this line.
      //    Worth knowing before adding a deployment-time CORS control and
      //    expecting it to cover the widget.
      //
      // 2. The wildcard is FUNCTION-WIDE, not route-wide. This function also
      //    serves the authenticated /feedback-forms, /{form_id}, /submissions
      //    and /stats routes, so their responses carry '*' too — which is the
      //    very reasoning the ballots Lambda's comment uses to REJECT '*' for
      //    itself. The paragraph above is why that is safe rather than why it
      //    is tidy: the honest shape is two variables (ALLOWED_ORIGIN = the
      //    site origin, plus a PUBLIC_ALLOWED_ORIGIN = '*' returned only on the
      //    three widget responses), which is a feedback_form_handler.py change
      //    and therefore a follow-up, not part of a CDK-only change.
      ALLOWED_ORIGIN: '*',
      POWERTOOLS_SERVICE_NAME: 'voc-feedback-form-api',
      LOG_LEVEL: 'INFO',
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('FeedbackFormApiLogs', ctx.uniqueName('voc-feedback-form-api')),
  });

  // Anonymous Ballots API (voting sessions)
  //
  // Its OWN Lambda, its own role and its own resource tree, because two of its
  // routes are served without credentials. A public route carved out of the
  // authenticated /projects proxy is the shape that once left form update,
  // delete and submission reads anonymous (see api-stack.test.ts), and the
  // feedback-form routes are public for a customer widget rather than for this.
  //
  // ONE WRITABLE TABLE: the aggregates table, which holds both the voting
  // session records and the prioritization ballots (plus a single GetItem on the
  // projects table, below, for the project-access gate). Deliberately NO feedback
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
  //
  // `UpdateItem` also covers the ballot write's TRANSACTION, and no fourth action
  // is needed for it. `TransactWriteItems` is authorised per PARTICIPANT rather
  // than as an action of its own, and both of that transaction's participants are
  // `Update` — the ballot record, and the row's freeze mark plus the counter a row
  // delete fences on. It needs no `ConditionCheckItem`, because the row's condition
  // rides on its own `Update` rather than on a separate `ConditionCheck`; that
  // shape is what keeps this role at three actions.
  const ballotsRole = ctx.role('BallotsLambdaRole');
  aggregatesTable.grant(ballotsRole, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem');
  // ONE read on the projects table: opening a session is gated on the caller's
  // edit access to the row's project (shared/project_access.py), which needs
  // that project's META. GetItem only — no Query/Scan, so a flaw here still
  // cannot enumerate projects.
  projectsTable.grant(ballotsRole, 'dynamodb:GetItem');
  kmsKey.grantEncryptDecrypt(ballotsRole);

  const ballotsLambda = new lambda.Function(stack, 'BallotsApi', {
    functionName: ctx.uniqueName('voc-ballots-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'ballots_handler.lambda_handler',
    code: createApiLambdaCode('ballots_handler.py'),
    role: ballotsRole,
    timeout: cdk.Duration.seconds(30),
    // Power Tuning 2026-10-06 picked 512, pinned 1024; superseded 2026-10-18 (90.9 % p95 at 1024 MB,
    // lib/sizing/policy.ts)
    memorySize: 1769, // CPU-bound: 90.9 % p95 at 1024 MB, projected 60.6 % at 1536 → one vCPU (lib/sizing/policy.ts)
    environment: {
      AGGREGATES_TABLE: aggregatesTable.tableName,
      PROJECTS_TABLE: projectsTable.tableName,
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
    logGroup: ctx.logGroup('BallotsApiLogs', ctx.uniqueName('voc-ballots-api')),
  });

  // Chat API: saved conversations only. chat_handler.py reads CONVERSATIONS_TABLE and
  // nothing else, and makes no model call (the assistant itself is voc-chat-stream).
  const chatRole = ctx.role('ChatLambdaRole');
  // The caller's own conversations: save (Put), rename (Update), DELETE /chat/conversations/{id} (Delete). No batch.
  grantReadAndWrites(conversationsTable, chatRole, ['PutItem', 'UpdateItem', 'DeleteItem']);
  kmsKey.grantEncryptDecrypt(chatRole);
  // Inside a workspace the caller's conversations are theirs there: the routes resolve the caller's own membership
  // (no platform-admin entry, as the stream Lambda: no Cognito look-up and no audit row, so only the membership reads).
  const chatWorkspaceEnv = grantWorkspaceMembershipReads(ctx.props.workspacesTable, chatRole);

  const chatLambda = new lambda.Function(stack, 'ChatApi', {
    functionName: ctx.uniqueName('voc-chat-api'),
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'chat_handler.lambda_handler',
    code: createApiLambdaCode('chat_handler.py'),
    role: chatRole,
    timeout: CHAT_API_TIMEOUT,
    memorySize: 1024, // CPU-bound: memory buys vCPU; keep CPU <= 60% of the share
    environment: {
      CONVERSATIONS_TABLE: conversationsTable.tableName, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: 'voc-chat-api', LOG_LEVEL: 'INFO',
      // Named for the shared resolution module's live check, which these routes never run (elevate=False): no
      // Cognito grant goes with it, so a later call that did elevate would be refused, not silently elevated.
      USER_POOL_ID: userPool.userPoolId,
      ...chatWorkspaceEnv,
    },
    layers: [apiLayer],
    logGroup: ctx.logGroup('ChatApiLogs', ctx.uniqueName('voc-chat-api')),
  });

  return { logsLambda, usersLambda, feedbackFormLambda, ballotsLambda, chatLambda };
}
