/**
 * Some of the engineering runtime's grants (engineering-runtime.ts), kept apart so that file stays within its size:
 * the spend ledger's update (the session store's priced writes), the supervisor's budget work (a flow's month total,
 * the budget alerts, the hard cap), the Deny that keeps every other voc-agents writer off the hard cap's row (the
 * agents' runtime, agent-runtime.ts), an issue's trusted triage row (7.50.00: the runtime's create-only write, and the
 * Deny that keeps every other voc-agents writer off it), the agents' transcripts and the runs' manifests (7.50.00), the
 * sessions' walls record (7.50.03) and a KMS key's use through named services only.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

import { ENGINEERING_BUDGET_ALERT_PARTITIONS, ENGINEERING_SPEND_PARTITIONS, ENGINEERING_WORKSPACE } from './core-buckets';
import { engineeringAgentsEnabled } from './engineering-broker';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';

/**
 * The spend ledger's rows (engineering/spend.py): the session store ADDs to them in the same transaction as each
 * priced write of a session (a transaction is authorised by its items' own actions), so every role that saves a
 * session needs this. UpdateItem only, on the month partitions only; no GetItem, Query or delete here (IAM cannot
 * limit an update to ADDs: the code's ADD-only expressions do; the supervisor's own GetItem of a flow's month total
 * is a statement of its own, grantBudgetWork's SpendTotals).
 */
function grantSpendLedger(role: iam.IRole, table: dynamodb.ITable): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'SpendLedger',
    actions: ['dynamodb:UpdateItem'],
    resources: [table.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [ENGINEERING_SPEND_PARTITIONS] } },
  }));
}

/**
 * The walls each language's sessions said they run behind (7.50.03, lambda/engineering/runtime/sandbox.py): one row
 * per language, put by a launcher (the supervisor's or the delivery function's role) at each session's start, which the
 * Agents API's readiness reads (`sandbox`, with the GetItem its role has already). PutItem only, on that partition only.
 */
function grantSandboxRecord(role: iam.IRole, table: dynamodb.ITable): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'SandboxRecord', actions: ['dynamodb:PutItem'], resources: [table.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#SANDBOX'] } },
  }));
}

/** A launcher's own rows beside the runs' (the supervisor's and the delivery function's roles): the spend ledger's
 * update and the sessions' walls record. */
export function grantLauncherRows(role: iam.IRole, table: dynamodb.ITable): void {
  grantSpendLedger(role, table);
  grantSandboxRecord(role, table);
}

/** The hard cap's partition in voc-agents (lambda/engineering/settings.py SETTINGS_KEY). */
export const HARD_CAP_PARTITION = 'SETTINGS#engineering';
/** The repository connections' partitions in voc-agents (lambda/engineering/connectors/connections.py PARTITION). */
export const CONNECTIONS_PARTITIONS = 'CONNECTIONS#*';
/** The Sid of {@link denyHardCapWrites}' statement. */
export const HARD_CAP_DENY_SID = 'DenyHardCapWrites';

/**
 * An explicit Deny of every write on the administrators' engineering partitions of voc-agents, for a role that may
 * write voc-agents elsewhere: the hard cap's (its `HARD_CAP` row and its `LOG#` history rows) and the repository
 * connections' (each connection's row and its `LOG#` audit rows, 7.03.00). The Agents API is their one writer, so no
 * other role can turn the cap on or off, change a connection, or overwrite their history. `ForAnyValue`, as
 * audit-row-guard.ts and engineering-bus.ts denyCostRows: denied when ANY key a request names is one of those
 * partitions. An explicit Deny wins over every Allow, so a later broad grant cannot reopen it.
 */
export function denyHardCapWrites(role: iam.IRole, agentsTable: dynamodb.ITable): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: HARD_CAP_DENY_SID,
    effect: iam.Effect.DENY,
    actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'],
    resources: [agentsTable.tableArn],
    conditions: { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': [HARD_CAP_PARTITION, CONNECTIONS_PARTITIONS] } },
  }));
}

/**
 * The supervisor's budget work (engineering/spend.py, engineering/settings.py): a flow's month total, its budget
 * alerts' own partition and the administrators' hard cap. The supervisor's role alone: the delivery role has none of it.
 */
export function grantBudgetWork(role: iam.IRole, engineeringTable: dynamodb.ITable, agentsTable: dynamodb.ITable): void {
  // A flow's month total, read by GetItem for its budget's alerts and the hard cap (spend.py flow_month_usd); never a
  // Query of a month.
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'SpendTotals',
    actions: ['dynamodb:GetItem'],
    resources: [engineeringTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [ENGINEERING_SPEND_PARTITIONS] } },
  }));
  // The budget alerts' claims and their close (spend.py claim_alert, alert_sent), in a partition of their own: the
  // delivery role has no grant on it, and the bus's table-wide roles an explicit Deny (engineering-bus.ts
  // denyCostRows), so no other writer can make, and so mute, an alert.
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'BudgetAlerts',
    // (GetItem: a refused claim reads back the row it found, ReturnValuesOnConditionCheckFailure)
    actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
    resources: [engineeringTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [ENGINEERING_BUDGET_ALERT_PARTITIONS] } },
  }));
  // The administrators' hard cap (engineering/settings.py): its one row in voc-agents, read at a budgeted start;
  // the Agents API writes it. GetItem of that partition only.
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'HardCapSetting',
    actions: ['dynamodb:GetItem'],
    resources: [agentsTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [HARD_CAP_PARTITION] } },
  }));
}

/**
 * An issue's trusted triage rows in voc-agents (7.50.00, `ISSUE_TRIAGE#<ws>` / `<owner/name>#<n>`:
 * lambda/engineering/runtime/triage_end.py writes them create-only, at a triage run's end; an act trigger's
 * `requires_triage` reads them, agents/heartbeat/issues.py).
 */
export const ISSUE_TRIAGE_PARTITIONS = 'ISSUE_TRIAGE#*';
/** The Sid of {@link denyIssueTriageWrites}' statement. */
export const ISSUE_TRIAGE_DENY_SID = 'DenyIssueTriageWrites';

/**
 * An explicit Deny of every write on the issues' trusted triage rows, for a role that may write voc-agents elsewhere
 * (the Agents API, the heartbeat, the agents' runtime): voc-engineering-runtime is their one writer, so the row an
 * engineering agent's `requires_triage` trusts is only ever a triage run's. `ForAnyValue`, as {@link denyHardCapWrites}.
 */
export function denyIssueTriageWrites(scope: Construct, role: iam.IRole, agentsTable: dynamodb.ITable): void {
  // (only with the engineering module: without it no row of the kind exists and the default synth stays as it was)
  if (!engineeringAgentsEnabled(scope)) return;
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: ISSUE_TRIAGE_DENY_SID,
    effect: iam.Effect.DENY,
    actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'],
    resources: [agentsTable.tableArn],
    conditions: { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': [ISSUE_TRIAGE_PARTITIONS] } },
  }));
}

/** An understander's recorded triage of a run (7.50.00, lambda/engineering/runtime/triage_end.py). */
export const TRIAGE_RECORD_KEYS = 'ws/*/runs/*/*/commits/*/_triage/*';

/**
 * A triage run's end (7.50.00, lambda/engineering/runtime/triage_end.py, from the retrospective), on the runtime's role:
 * the understander's recorded triage read (`GetObject` on the runs' `_triage/` objects only, no listing) and the
 * issue's trusted row written to voc-agents, create-only (`PutItem` on `ISSUE_TRIAGE#*` only: no update, no delete, no
 * other partition of voc-agents; the hard cap's and the connections' rows explicitly denied, as for every voc-agents
 * writer).
 */
function grantIssueTriage(role: iam.IRole, workspaceBucket: s3.IBucket, agentsTable: dynamodb.ITable): void {
  const records = workspaceBucket.arnForObjects(TRIAGE_RECORD_KEYS);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'IssueTriageRecords', actions: ['s3:GetObject'], resources: [records],
  }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'Read-only on the understanders\' triage objects of every run: a run\'s end reads only the key its understander task recorded',
    findings: [resourceFinding(records)],
  }]);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'IssueTriageRows', actions: ['dynamodb:PutItem'], resources: [agentsTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [ISSUE_TRIAGE_PARTITIONS] } },
  }));
  denyHardCapWrites(role, agentsTable);
}

/** `actions` on `key`, only when one of `services` (in this region) calls KMS for the role. */
export function viaServices(key: kms.IKey, actions: string[], services: string[]): iam.PolicyStatement {
  const region = cdk.Stack.of(key).region;
  return new iam.PolicyStatement({
    actions,
    resources: [key.keyArn],
    conditions: { StringEquals: { 'kms:ViaService': services.map((service) => `${service}.${region}.amazonaws.com`) } },
  });
}

/**
 * The agents' transcripts (lambda/engineering/runtime/harness/transcript.py, 7.50.00): each session writes its own under
 * its own keys (the agent role's `WriteOwnKeys`, unchanged), and nobody else writes them. Learn reads a failed
 * attempt's (learning/transcripts.py).
 */
const TRANSCRIPT_KEYS = `ws/${ENGINEERING_WORKSPACE}/runs/*/*/commits/*/_transcripts/*`;
/** A run's manifests and the transcripts' index by flow and day (lambda/engineering/runtime/manifest.py). */
const MANIFEST_KEYS = `ws/${ENGINEERING_WORKSPACE}/runs/*/_manifest/*`;
const TRANSCRIPT_INDEX_KEYS = `ws/${ENGINEERING_WORKSPACE}/transcripts-index/*`;

/**
 * The runtime's role at a run's end (7.50.00): the issue's trusted triage row (``grantIssueTriage``), and Learn's read
 * of the agents' transcripts and the run's manifest and index entry (``grantTranscripts``).
 *
 * The runtime's role (Learn, the run's end): read the agents' transcripts (GetObject, and a listing under their
 * prefix only), and write each run's manifest and its index entry, create-only (the workspace bucket refuses a put
 * without If-None-Match). No other run object is written, and no transcript.
 */
export function grantRunEnd(role: iam.IRole, workspaceBucket: s3.IBucket, agentsTable: dynamodb.ITable): void {
  grantIssueTriage(role, workspaceBucket, agentsTable);
  grantTranscripts(role, workspaceBucket);
}

function grantTranscripts(role: iam.IRole, workspaceBucket: s3.IBucket): void {
  const transcripts = workspaceBucket.arnForObjects(TRANSCRIPT_KEYS);
  const written = [MANIFEST_KEYS, TRANSCRIPT_INDEX_KEYS].map((keys) => workspaceBucket.arnForObjects(keys));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'LearnReadsTranscripts', actions: ['s3:GetObject'], resources: [transcripts],
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'LearnListsTranscripts', actions: ['s3:ListBucket'], resources: [workspaceBucket.bucketArn],
    conditions: { StringLike: { 's3:prefix': [TRANSCRIPT_KEYS] } },
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'WriteRunManifests', actions: ['s3:PutObject'], resources: written,
  }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'The agents\' transcript objects (read only, one per run, agent, commit and attempt, known only at run time) and each run\'s manifest and index entry (create-only): no other run object',
    findings: [transcripts, ...written].map(resourceFinding),
  }]);
}

