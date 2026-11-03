/**
 * Audit rows can be changed or removed by no role, and written only by their writer (TENETS.md D4; wave C owner
 * decision 4: audit trails never expire, and only their writer can write them).
 *
 * Audit, tombstone and delete-record rows live under partition keys that start with `AUDIT#`, in the tables that
 * hold them: voc-aggregates (`AUDIT#retention`, `AUDIT#tombstone#<source>`, written by voc-retention) and
 * voc-projects / voc-participants / voc-feature-requests (`AUDIT#delete`, written by the API that deletes the
 * artifact, lambda/shared/delete_audit.py, which only PUTs a new row). Every role that can write in one of those
 * tables gets, on it, an explicit Deny pinned by `dynamodb:LeadingKeys` to `AUDIT#*`:
 *
 *   - every writer: Deny DeleteItem and UpdateItem (no audit row is ever changed or removed);
 *   - a role that is not that table's audit writer: also Deny PutItem and BatchWriteItem (it cannot forge or
 *     overwrite one, nor delete one through a batch).
 *
 * The audit writer of a table is a role that deletes there without a key condition (a workspace delete records
 * itself with `record_delete`), or a role named in {@link AuditGuardOptions.writers} (voc-retention on
 * voc-aggregates). An explicit Deny wins over every Allow, so a later broad grant cannot reopen the rows.
 *
 * `ForAnyValue:StringLike`, not `ForAllValues`: in a Deny, `ForAllValues` would let a batch that mixes one audit key
 * with any other key through; `ForAnyValue` denies the request when ANY partition key it names matches, and is
 * false when the request names none (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-single-vs-multi-valued-context-keys.html,
 * https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html).
 *
 * Inline, on each role's default policy (two statements, the tables it writes), not a managed policy per stack:
 * no new resource against the VocApiStack ceiling, and the size stays far under the 10,240-character inline quota
 * (api-stack-mcp.test.ts). Applied once at the end of the app (bin/voc-datalake.ts), after every grant.
 */
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IConstruct } from 'constructs';
import { z } from 'zod';

/** The partition-key pattern of every audit row. */
export const AUDIT_PARTITION_PATTERN = 'AUDIT#*';
/** Sids of the two statements this module adds. */
export const AUDIT_DENY_CHANGE_SID = 'DenyAuditRowChanges';
export const AUDIT_DENY_WRITE_SID = 'DenyAuditRowWritesByNonWriters';

const WRITE_ACTIONS = new Set(['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
  'dynamodb:BatchWriteItem', 'dynamodb:*']);
const DELETE_ACTIONS = new Set(['dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:*']);

export interface AuditGuardOptions {
  /** The tables that hold `AUDIT#*` rows. */
  readonly tables: readonly dynamodb.ITable[];
  /** Audit writers that delete nothing there: construct-path suffixes of their roles, per table. */
  readonly writers: readonly { readonly table: dynamodb.ITable; readonly rolePathSuffixes: readonly string[] }[];
}

const StatementSchema = z.looseObject({
  Effect: z.string().optional(),
  Action: z.union([z.string(), z.array(z.string())]).optional(),
  Resource: z.union([z.string(), z.array(z.unknown())]).optional(),
  Condition: z.unknown().optional(),
});
const DocumentSchema = z.looseObject({ Statement: z.array(z.unknown()).optional() }).optional();

/** The guarded table ARNs one Allow statement writes, or none. */
function tablesWritten(statement: z.infer<typeof StatementSchema>, tableArns: ReadonlySet<string>): string[] {
  const actions = [statement.Action ?? []].flat();
  if ((statement.Effect ?? 'Allow') !== 'Allow' || !actions.some((action) => WRITE_ACTIONS.has(action))) return [];
  return [statement.Resource ?? []].flat()
    .filter((resource): resource is string => typeof resource === 'string' && tableArns.has(resource));
}

const deletesWithoutCondition = (statement: z.infer<typeof StatementSchema>): boolean =>
  statement.Condition === undefined && [statement.Action ?? []].flat().some((action) => DELETE_ACTIONS.has(action));

/** For each guarded table (by its ARN token) a role's default policy writes: whether it deletes there unscoped. */
function writtenTables(policy: iam.Policy, tableArns: ReadonlySet<string>): Map<string, boolean> {
  const deletesUnscopedByArn = new Map<string, boolean>();
  const statements = DocumentSchema.parse(policy.document.toJSON())?.Statement ?? [];
  for (const statement of statements.map((raw) => StatementSchema.parse(raw))) {
    const unscoped = deletesWithoutCondition(statement);
    for (const arn of tablesWritten(statement, tableArns)) {
      deletesUnscopedByArn.set(arn, unscoped || (deletesUnscopedByArn.get(arn) ?? false));
    }
  }
  return deletesUnscopedByArn;
}

const denyOnAuditRows = (sid: string, actions: string[], resources: string[]) => new iam.PolicyStatement({
  sid,
  effect: iam.Effect.DENY,
  actions,
  resources,
  conditions: { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': [AUDIT_PARTITION_PATTERN] } },
});

/** Add the audit-row Denies to every role under `scope` that writes a guarded table (see the module comment). */
export function applyAuditRowGuard(scope: IConstruct, options: AuditGuardOptions): void {
  const tableArns = new Set(options.tables.map((table) => table.tableArn));
  const roles = scope.node.findAll().filter((construct): construct is iam.Role => construct instanceof iam.Role);
  for (const role of roles) {
    const policy = role.node.tryFindChild('DefaultPolicy');
    if (!(policy instanceof iam.Policy)) continue;
    const written = writtenTables(policy, tableArns);
    if (written.size === 0) continue;
    const isNamedWriter = (arn: string) => options.writers.some((writer) => writer.table.tableArn === arn
      && writer.rolePathSuffixes.some((suffix) => role.node.path.endsWith(suffix)));
    const notWriterOf = [...written].filter(([arn, deletesUnscoped]) => !deletesUnscoped && !isNamedWriter(arn))
      .map(([arn]) => arn);
    role.addToPrincipalPolicy(denyOnAuditRows(AUDIT_DENY_CHANGE_SID, ['dynamodb:DeleteItem', 'dynamodb:UpdateItem'],
      [...written.keys()]));
    if (notWriterOf.length > 0) {
      role.addToPrincipalPolicy(denyOnAuditRows(AUDIT_DENY_WRITE_SID, ['dynamodb:PutItem', 'dynamodb:BatchWriteItem'],
        notWriterOf));
    }
  }
}
