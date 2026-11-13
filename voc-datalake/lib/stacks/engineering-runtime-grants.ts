/**
 * Some of the engineering runtime's grants (engineering-runtime.ts), kept apart so that file stays within its size:
 * the spend ledger's update (the session store's priced writes), the supervisor's budget work (a flow's month total,
 * the budget alerts, the hard cap), the Deny that keeps every other voc-agents writer off the hard cap's row (the
 * agents' runtime, agent-runtime.ts) and a KMS key's use through named services only.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';

import { ENGINEERING_BUDGET_ALERT_PARTITIONS, ENGINEERING_SPEND_PARTITIONS } from './core-buckets';

/**
 * The spend ledger's rows (engineering/spend.py): the session store ADDs to them in the same transaction as each
 * priced write of a session (a transaction is authorised by its items' own actions), so every role that saves a
 * session needs this. UpdateItem only, on the month partitions only; no GetItem, Query or delete here (IAM cannot
 * limit an update to ADDs: the code's ADD-only expressions do; the supervisor's own GetItem of a flow's month total
 * is a statement of its own, grantBudgetWork's SpendTotals).
 */
export function grantSpendLedger(role: iam.IRole, table: dynamodb.ITable): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'SpendLedger',
    actions: ['dynamodb:UpdateItem'],
    resources: [table.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [ENGINEERING_SPEND_PARTITIONS] } },
  }));
}

/** The hard cap's partition in voc-agents (lambda/engineering/settings.py SETTINGS_KEY). */
export const HARD_CAP_PARTITION = 'SETTINGS#engineering';
/** The Sid of {@link denyHardCapWrites}' statement. */
export const HARD_CAP_DENY_SID = 'DenyHardCapWrites';

/**
 * An explicit Deny of every write on the hard cap's partition of voc-agents (its `HARD_CAP` row and its `LOG#` history
 * rows), for a role that may write voc-agents elsewhere: the Agents API is the setting's one writer, so no other role
 * can turn the cap on or off or overwrite its history. `ForAnyValue`, as audit-row-guard.ts and engineering-bus.ts
 * denyCostRows: denied when ANY key a request names is that partition. An explicit Deny wins over every Allow, so a
 * later broad grant cannot reopen it.
 */
export function denyHardCapWrites(role: iam.IRole, agentsTable: dynamodb.ITable): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: HARD_CAP_DENY_SID,
    effect: iam.Effect.DENY,
    actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'],
    resources: [agentsTable.tableArn],
    conditions: { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': [HARD_CAP_PARTITION] } },
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

/** `actions` on `key`, only when one of `services` (in this region) calls KMS for the role. */
export function viaServices(key: kms.IKey, actions: string[], services: string[]): iam.PolicyStatement {
  const region = cdk.Stack.of(key).region;
  return new iam.PolicyStatement({
    actions,
    resources: [key.keyArn],
    conditions: { StringEquals: { 'kms:ViaService': services.map((service) => `${service}.${region}.amazonaws.com`) } },
  });
}
