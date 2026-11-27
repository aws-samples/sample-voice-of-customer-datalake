/**
 * voc-retention — the per-source retention / erasure worker (retention-worker.ts,
 * docs/source-policies.md). The one role allowed to delete customer data, so its
 * grants are pinned EXACTLY: any widening (a Put on feedback, a bucket-wide delete,
 * a delete on aggregates outside the test responses' own partitions) fails here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { IgnoreStrategy } from 'aws-cdk-lib';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { RETENTION_ENGINEERING_FILES, RETENTION_OWN_EXCLUDES } from './retention-worker';
import { RETENTION_FUNCTION_BASE_NAME } from '../utils/function-names';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { itemAt } from '../test-support/guards';
import {
  IamPolicySchema, allowedActions, isAttachedToRole, isAuditRowGuardStatement, roleStatements, statementActions,
} from '../test-support/iam-statements';
import { byCodeUnit } from '../utils/compare';
import { expectSelfInvokeOnly, findWorkerFunction } from '../test-support/worker-function';

const RuleSchema = z.object({
  Properties: z.object({
    ScheduleExpression: z.string(),
    Targets: z.array(z.object({ Input: z.string().optional() })),
  }),
});

const ManagedPolicySchema = z.object({
  Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(z.object({
    Effect: z.string(), Action: z.union([z.string(), z.array(z.string())]),
  })) }) }),
});

let template: Template;
beforeAll(() => { template = synthProcessingTemplate({ withIndexes: true }); });

/** The retention worker's customer-managed policies, by logical id. */
const retentionManaged = (synthesized: Template) => Object.entries(synthesized.findResources('AWS::IAM::ManagedPolicy'))
  .filter(([id]) => id.startsWith('RetentionWorker'));
/** The actions a managed policy allows. */
const allowedIn = (resource: unknown) => ManagedPolicySchema.parse(resource).Properties.PolicyDocument.Statement
  .filter((statement) => statement.Effect === 'Allow').flatMap((statement) => [statement.Action].flat());
/** A policy document's size as IAM counts it (no whitespace), each ARN token as a resolved ARN of 90 characters (a
 *  table's is about 70, a user pool's about 80). */
const resolvedSize = (document: unknown): number => JSON.stringify(document, (_key, value: unknown) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).some((key) => key.startsWith('Fn::') || key === 'Ref') ? 'a'.repeat(90) : value)
  .replace(/\s/g, '').length;
/** Any overflow policy CDK split off the role's own (none may exist: it would move statements of its choosing). */
const overflowPolicies = (synthesized: Template) => Object.keys(synthesized.findResources('AWS::IAM::ManagedPolicy'))
  .filter((id) => id.startsWith('RetentionWorkerRetentionRoleOverflow'));

const worker = () => findWorkerFunction(template, 'voc-retention-');

const statements = () => roleStatements(template, worker().Role['Fn::GetAtt'][0]);

describe('voc-retention worker', () => {
  it('runs the contract handler with a 15-minute ceiling and no hidden re-drive', () => {
    expect(worker().Handler).toBe('jobs/retention/handler.lambda_handler');
    expect(worker().Timeout).toBe(900);
    const functionId = Object.keys(template.findResources('AWS::Lambda::Function'))
      .filter((id) => id.startsWith('RetentionWorkerRetention'));
    const config = Object.values(template.findResources('AWS::Lambda::EventInvokeConfig'))
      .filter((c) => JSON.stringify(c).includes(`"Ref":"${itemAt(functionId, 0)}"`));
    expect(JSON.stringify(config)).toContain('"MaximumRetryAttempts":0');
  });

  it('is handed both tables and the raw bucket, but not its own name (it re-invokes via context.function_name)', () => {
    const variables = worker().Environment.Variables;
    expect(Object.keys(variables)).toStrictEqual(expect.arrayContaining([
      'FEEDBACK_TABLE', 'AGGREGATES_TABLE', 'RAW_DATA_BUCKET', 'RADAR_TABLE', 'PROJECTS_TABLE', 'FEATURE_REQUESTS_TABLE',
      'PARTICIPANTS_TABLE',
    ]));
    expect(variables).not.toHaveProperty('RETENTION_FUNCTION');
  });

  it('prints its alarm\'s metrics under the service the logs API alarms on (7.93.00)', () => {
    // lambda/jobs/retention/registries.py `emit` names POWERTOOLS_SERVICE_NAME; dlq-alarms.ts hands the logs API
    // RETENTION_FUNCTION_BASE_NAME as OPS_ALERTS_RETENTION_SERVICE (api-stack-mcp-global-ops.test.ts).
    expect(worker().Environment.Variables.POWERTOOLS_SERVICE_NAME).toBe(RETENTION_FUNCTION_BASE_NAME);
  });

  it('holds exactly GetItem/Query/Scan/DeleteItem on feedback — never Put, Update or BatchWrite', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'Feedback'))
      .toStrictEqual(['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan']);
  });

  it('holds exactly Get/Put/Update/Query plus the tombstone batches on aggregates, and a delete of test responses only', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'Aggregates')).toStrictEqual([
      'dynamodb:BatchGetItem', 'dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem',
      'dynamodb:Query', 'dynamodb:UpdateItem',
    ]);
  });

  /** Every Allow of the role (its inline AND managed policies) that can delete on aggregates. */
  const aggregatesDeletes = () => {
    const role = worker().Role['Fn::GetAtt'][0];
    return [...Object.values(template.findResources('AWS::IAM::Policy')),
      ...Object.values(template.findResources('AWS::IAM::ManagedPolicy'))]
      .map((resource) => IamPolicySchema.parse(resource).Properties)
      .filter((policy) => isAttachedToRole(policy, role))
      .flatMap((policy) => policy.PolicyDocument.Statement)
      .filter((statement) => (statement.Effect ?? 'Allow') === 'Allow' && !isAuditRowGuardStatement(statement)
        && JSON.stringify(statement.Resource).includes('Aggregates')
        && statementActions(statement).some((a) => ['dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:*'].includes(a)));
  };

  it('deletes on aggregates only in the test responses\' own partitions, FEEDBACK_FORM_TEST (form_tests.py)', () => {
    // One statement, DeleteItem alone (never a batch), pinned to the deployment's test partition and one workspace
    // id's (`?`: one character each, so the pattern names exactly one workspace id's shape).
    expect(aggregatesDeletes().map((statement) => [statementActions(statement), statement.Condition])).toStrictEqual([
      [['dynamodb:DeleteItem'], { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [
        'FEEDBACK_FORM_TEST', `WS#ws_${'?'.repeat(26)}#FEEDBACK_FORM_TEST`] } }],
    ]);
  });

  it('cannot delete a form\'s definition, revision or funnel row, nor any other aggregates row', () => {
    // No delete without a partition pin, and none that names a forms partition (FEEDBACK_FORM, a workspace's
    // WS#{ws}#FEEDBACK_FORM: FORM#, FORMREV#, FORMFUNNEL#, FORMSESSION#) or a `*` pattern (it would reach one).
    const pins = aggregatesDeletes().map((statement) => JSON.stringify(statement.Condition ?? null));
    expect(pins.filter((pin) => pin === 'null')).toStrictEqual([]);
    expect(pins.filter((pin) => /FEEDBACK_FORM"/.test(pin) || pin.includes('*'))).toStrictEqual([]);
  });

  it('holds exactly Scan/DeleteItem on radar, plus the version bump pinned to SETTINGS#radar', () => {
    const radar = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('Radar')
      && s.actions.some((a) => a.startsWith('dynamodb:')));
    expect(radar.map((s) => [...s.actions].sort(byCodeUnit).join(','))).toStrictEqual([
      'dynamodb:DeleteItem,dynamodb:Scan', 'dynamodb:UpdateItem',
    ]);
    expect(JSON.stringify(template.toJSON())).toContain('"dynamodb:LeadingKeys":["SETTINGS#radar"]');
  });

  it('holds exactly BatchGetItem/Query/UpdateItem on projects, never a Scan, a delete or a put (7.93.00)', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'Projects'))
      .toStrictEqual(['dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
    const queries = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('Projects')
      && s.actions.includes('dynamodb:Query'));
    // Query alone: on the table, of any one workspace id's partitions (7.43.00) and of the deployment's (7.48.00); and
    // (7.93.00, 3g-d2) one of gsi1-by-type, the gap check's, its one index. The registry lists the projects (a deleted
    // project's META is off the index); the index only checks it.
    expect(queries.map((s) => [s.actions, s.resource.includes('/index/')]).sort(
      (a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b))))
      .toStrictEqual([[['dynamodb:Query'], false], [['dynamodb:Query'], false], [['dynamodb:Query'], true]]);
    expect(queries.filter((s) => s.resource.includes('/index/')).map((s) => s.resource))
      .toStrictEqual([expect.stringContaining('/index/gsi1-by-type')]);
  });

  it('batch-gets the project registry\'s rows for their key only (7.93.00, the gap check\'s lookup)', () => {
    const batches = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('Projects')
      && s.actions.includes('dynamodb:BatchGetItem'));
    expect(batches.map((s) => [s.actions, s.resource.includes('/index/')])).toStrictEqual([[['dynamodb:BatchGetItem'],
      false]]);
    expect(JSON.stringify(template.toJSON())).toContain(JSON.stringify({
      'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['PROJECT_IDS'], 'dynamodb:Attributes': ['pk', 'sk'] },
      StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
    }));
  });

  it('reads the project index for the keys of the deployment\'s live projects only (7.93.00, the gap check)', () => {
    // Its partition (never a workspace's, never a project's documents), the table's and the index's keys, and
    // SPECIFIC_ATTRIBUTES required: no project row's other attributes can be read through it.
    expect(JSON.stringify(template.toJSON())).toContain(JSON.stringify({
      'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['TYPE#PROJECT'],
        'dynamodb:Attributes': ['pk', 'sk', 'gsi1pk', 'gsi1sk'] },
      StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
    }));
  });

  it('reads voc-feedback\'s day and id indexes for a workspace\'s keys only, in the reads policy (7.96.00)', () => {
    const ws = `WS#ws_${'?'.repeat(26)}`;
    const [, reads] = retentionManaged(template).find(([id]) => id.startsWith('RetentionWorkerRetentionReadsPolicy')) ?? [];
    const indexQueries = IamPolicySchema.parse(reads).Properties.PolicyDocument.Statement
      .filter((statement) => JSON.stringify(statement.Resource).includes('Feedback'));
    // Two Queries, each on its own index, a workspace's partitions only, its keys and its filter's attributes only
    // (the erasure's own filter), a projection required.
    const filter = ['author', 'csv_row_id', 'metadata', 'source_id', 'source_platform'];
    expect(indexQueries.map((statement) => [statement.Sid, statement.Action,
      /\/index\/[a-z0-9-]+/.exec(JSON.stringify(statement.Resource))?.[0], statement.Condition])).toStrictEqual([
      ['QueryWorkspaceFeedbackDays', 'dynamodb:Query', '/index/gsi1-by-date', {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${ws}#DATE#*`] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'gsi1pk', 'gsi1sk', ...filter] },
        StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' } }],
      ['QueryWorkspaceFeedbackIds', 'dynamodb:Query', '/index/gsi4-by-feedback-id', {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${ws}#FEEDBACK#*`] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'gsi4pk', ...filter] },
        StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' } }],
    ]);
    // The META's created_at (where the day walk starts), held to it and the keys, a projection required.
    expect(JSON.stringify(reads)).toContain(JSON.stringify({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*'] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'created_at'] },
      StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      Null: { 'dynamodb:Attributes': 'false' },
    }));
    // Nothing on voc-feedback's indexes in the role's own policy or the walks' (the inline quota; 7.72.00's rule).
    const elsewhere = [...Object.entries(template.findResources('AWS::IAM::Policy')), ...retentionManaged(template)]
      .filter(([id]) => /^RetentionWorkerRetention(RoleDefaultPolicy|WalksPolicy)/.test(id))
      .flatMap(([, resource]) => IamPolicySchema.parse(resource).Properties.PolicyDocument.Statement)
      .filter((statement) => JSON.stringify(statement.Resource).includes('Feedback'));
    expect(elsewhere.map((statement) => JSON.stringify(statement.Resource))
      .filter((resource) => resource.includes('/index/'))).toStrictEqual([]);
  });

  it('queries exactly these project partitions: one workspace id\'s and the deployment\'s, its registries included', () => {
    const ws = `WS#ws_${'?'.repeat(26)}`;
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain(JSON.stringify({ 'ForAllValues:StringLike': {
      'dynamodb:LeadingKeys': [`${ws}#PROJECT_IDS`, `${ws}#PROJECT#*`, `${ws}#DCOMMENTS#*`, `${ws}#DOCSHARE_IDS`,
        `${ws}#DOCSHARE#*`, `${ws}#LIBRARY`],
    } }));
    // The deployment's: its own partitions and its registries, each read only for the attributes the erasure and
    // the lineage marks read (7.48.00).
    expect(json).toContain(JSON.stringify({
      // And (7.62.00) the Documents Library's items, for the address in their metadata (title, source, tags, and the
      // names of who made and changed it).
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PROJECT#*', 'DCOMMENTS#*', 'DOCSHARE#*', 'PROJECT_IDS',
        'DOCSHARE_IDS', 'COMMENT_SERIES_IDS', 'LIBRARY'] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'author', 'replies', 'status_by', 'audience',
        'created_by_name', 'revoked_by', 'revoked', 'project_id', 'owner_email', 'members', 'research_notes',
        's3_raw_key', 'content_type', 'status', 's3_extracted_key', 'filename', 'deleted_at', 'deletion_started_at',
        'completed_at', 'release', 'links_found', 'series_found', 'projects_found', 'input_feedback_ids', 'evidence_feedback_ids',
        'input_feature_request_ids', 'evidence_updates', 'erased_evidence', 'title', 'source', 'tags', 'created_by', 'updated_by'] },
      // A Query naming no attribute would pass ForAllValues and read whole rows: SPECIFIC_ATTRIBUTES is required.
      StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
    }));
  });

  it('asks for no returned values on its attribute-limited updates: the two on projects, the membership one and the participants one', () => {
    // An UpdateItem limited to some attributes could otherwise read the whole row back (ALL_OLD, ALL_NEW).
    const policy = JSON.stringify(template.toJSON().Resources);
    const noReturn = JSON.stringify({ StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] } }).slice(1, -1);
    expect(policy.split(noReturn).length - 1).toBe(4);
    const limited = statements().filter((s) => s.effect === 'Allow' && s.actions.includes('dynamodb:UpdateItem')
      && ['Projects', 'Workspaces', 'Participants'].some((table) => s.resource.includes(table)));
    expect(limited).toHaveLength(4);
  });

  it('erases participants with exactly the participant erasure\'s calls, each pinned to its partitions (7.72.00)', () => {
    expect(worker().Environment.Variables).toHaveProperty('PARTICIPANTS_TABLE');
    const onParticipants = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('Participants')
      && s.actions.some((a) => a.startsWith('dynamodb:')));
    // No Scan: each write in a statement of its own on the table (the role's own policy), then the reads together on
    // the table and the people index's Query (the walks' policy). BatchWriteItem would also allow puts in its
    // partitions (IAM cannot tell a batch's deletes from its puts); the code sends deletes only.
    const byStatement = (a: unknown, b: unknown) => byCodeUnit(JSON.stringify(a), JSON.stringify(b));
    expect(onParticipants.map((s) => [[...s.actions].sort(byCodeUnit), s.resource.includes('/index/')]).sort(byStatement))
      .toStrictEqual([
        [['dynamodb:PutItem'], false], [['dynamodb:UpdateItem'], false], [['dynamodb:DeleteItem'], false],
        [['dynamodb:BatchWriteItem'], false], [['dynamodb:Query'], true], [['dynamodb:GetItem'], false],
        [['dynamodb:ConditionCheckItem', 'dynamodb:GetItem', 'dynamodb:Query'], false],
      ].sort(byStatement));
    const ws = `WS#ws_${'?'.repeat(26)}`;
    const json = JSON.stringify(template.toJSON());
    const keys = (partitions: string[]) => JSON.stringify({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions } });
    for (const partitions of [
      ['EMAIL#*', 'PERSON#*', `${ws}#EMAIL#*`, `${ws}#PERSON#*`],
      ['AUDIT#tombstone#participant', 'AUDIT#delete'],
      ['EMAIL#*', 'PERSON#*', 'LIST#*', `${ws}#EMAIL#*`, `${ws}#PERSON#*`, `${ws}#LIST#*`, `${ws}#PARTICIPANTS`],
      ['TOKEN#*', 'PROJECT#*', 'PERSON#*', `${ws}#PROJECT#*`, `${ws}#PERSON#*`],
    ]) {
      expect(json).toContain(keys(partitions));
    }
    // The updates: a person's lists, a list's count, an ask recipient's token hash and error, nothing returned.
    expect(json).toContain(JSON.stringify({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PERSON#*', 'LIST#*', 'ASK#*', `${ws}#PERSON#*`,
        `${ws}#LIST#*`] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'list_ids', 'member_count',
        'response_token_hash', 'error'] },
      StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] },
    }));
  });

  it('reads the participants\' people index for its key alone, and a participant\'s tombstone only (7.72.00)', () => {
    const ws = `WS#ws_${'?'.repeat(26)}`;
    const json = JSON.stringify(template.toJSON());
    // The people index's Query: its partitions, the key it reads and the index keys only, SPECIFIC_ATTRIBUTES required.
    expect(json).toContain(JSON.stringify({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PEOPLE', `${ws}#PEOPLE`] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'gsi1pk', 'gsi1sk'] },
      StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
    }));
    // The GetItem of a participant's tombstone the workspace layer's put asks back (ALL_OLD on a taken key).
    expect(json).toContain(JSON.stringify({
      'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['AUDIT#tombstone#participant'] } }));
  });

  it('keeps every delete and put in its own inline policy; the walks\' managed policy reads and updates only (7.72.00; the engineering build: its own engineering test below)', () => {
    const managed = retentionManaged(template);
    // Policies of its own (7.84.00: the reads policy too), never a CDK overflow (which would move the role's last
    // statements, deletes included).
    expect(managed.map(([id]) => id.replace(/[0-9A-F]{8}$/, '')).sort(byCodeUnit)).toStrictEqual([
      'RetentionWorkerRetentionReadsPolicy', 'RetentionWorkerRetentionWalksPolicy']);
    const allowed = managed.flatMap(([, resource]) => allowedIn(resource));
    expect([...new Set(allowed)].sort(byCodeUnit)).toStrictEqual(['dynamodb:BatchGetItem', 'dynamodb:ConditionCheckItem',
      'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:UpdateItem', 's3:GetObject']);
    expect(overflowPolicies(template)).toStrictEqual([]);
  });

  it('holds the boards\' and memberships\' reads and updates in a reads policy of its own, attached to the role alone (7.84.00)', () => {
    const [, reads] = retentionManaged(template).find(([id]) => id.startsWith('RetentionWorkerRetentionReadsPolicy')) ?? [];
    // Reads and the de-identifying updates only (the audit-row guard's own Deny aside).
    expect([...new Set(allowedIn(reads))].sort(byCodeUnit)).toStrictEqual(['dynamodb:GetItem', 'dynamodb:Query',
      'dynamodb:Scan', 'dynamodb:UpdateItem']);
    expect(JSON.stringify(reads)).toContain(`"Roles":[{"Ref":"${worker().Role['Fn::GetAtt'][0]}"}]`);
    const denies = IamPolicySchema.parse(reads).Properties.PolicyDocument.Statement
      .filter((statement) => statement.Effect === 'Deny');
    const tablesOf = (sid: string) => denies.filter((statement) => (statement.Sid ?? '').startsWith(sid))
      .map((statement) => JSON.stringify(statement.Resource));
    // The audit-row guard: the boards and the memberships it updates get the full Deny (no audit row is the worker's
    // there); in voc-participants it is named a writer of the role's two partitions (lib/utils/audit-row-guard.ts), so
    // its Denies there are the change Deny and the other-partition one, never a Deny of the role's own puts
    // (retention-policy-evaluation.test.ts evaluates them together).
    expect(tablesOf('DenyAuditRowWritesByNonWriters').join()).not.toContain('Participants');
    expect(tablesOf('DenyAuditRowWritesByNonWriters').join()).toContain('FeatureRequests');
    expect(tablesOf('DenyAuditRowChanges').join()).toContain('Participants');
    expect(tablesOf('DenyAuditRowWritesOutsideOwnPartition').join()).toContain('Participants');
  });

  it('never scans projects: the Scan fallback\'s grant is gone (7.93.00, 3g-d2)', () => {
    const scans = statements().filter((s) => s.resource.includes('Projects') && s.actions.some(
      (a) => a === 'dynamodb:Scan' || a === 'dynamodb:*'));
    expect(scans.filter((s) => s.effect === 'Allow')).toStrictEqual([]);
    expect(JSON.stringify(template.toJSON())).not.toContain('ScanDeploymentReviewRows');
  });

  it('reads and updates feature requests, and puts / deletes only under FR#* (it re-keys an erased +1)', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'FeatureRequests')).toStrictEqual([
      'dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:Scan',
      'dynamodb:UpdateItem',
    ]);
    const writes = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('FeatureRequests')
      && s.actions.some((a) => a === 'dynamodb:PutItem' || a === 'dynamodb:DeleteItem'));
    expect(writes.map((s) => [...s.actions].sort(byCodeUnit).join(','))).toStrictEqual(['dynamodb:DeleteItem,dynamodb:PutItem']);
    expect(JSON.stringify(template.toJSON())).toContain('"dynamodb:LeadingKeys":["FR#*"]');
    // A wildcard needs a StringLike-family operator: StringEquals would deny every re-key at runtime.
    expect(JSON.stringify(template.toJSON())).toContain('"ForAllValues:StringLike":{"dynamodb:LeadingKeys":["FR#*"]}');
  });

  it('scans workspaces and updates only email and name under WS#* (it de-identifies membership rows)', () => {
    // GetItem: a META's status only, before an erasure takes a workspace's export lock (jobs/retention/exports.py).
    // Query: the platform's `WORKSPACES` listing only (7.43.00: an erasure by email walks every listed workspace).
    expect(allowedActions(statements(), 'dynamodb:', 'Workspaces'))
      .toStrictEqual(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:UpdateItem']);
    const update = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('Workspaces')
      && s.actions.includes('dynamodb:UpdateItem'));
    expect(update.map((s) => s.actions)).toStrictEqual([['dynamodb:UpdateItem']]);
    expect(JSON.stringify(template.toJSON())).toContain(
      '{"ForAllValues:StringLike":{"dynamodb:LeadingKeys":["WS#*"]},'
      + '"ForAllValues:StringEquals":{"dynamodb:Attributes":["email","name","pk","sk"]},'
      + '"StringEqualsIfExists":{"dynamodb:ReturnValues":["NONE"]}}');
    expect(worker().Environment.Variables).toHaveProperty('WORKSPACES_TABLE');
  });

  it('queries workspaces only in the platform\'s WORKSPACES listing (an erasure by email walks every listed workspace)', () => {
    const query = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('Workspaces')
      && s.actions.includes('dynamodb:Query'));
    expect(query.map((s) => s.actions)).toStrictEqual([['dynamodb:Query']]);
    expect(JSON.stringify(template.toJSON())).toContain(
      '{"ForAllValues:StringEquals":{"dynamodb:LeadingKeys":["WORKSPACES"]}}');
  });

  it('deletes objects and versions under raw/*, silver/* and each workspace\'s raw, silver and exports only, and lists versions of those prefixes only', () => {
    const s3 = statements().filter((s) => s.effect === 'Allow' && s.actions.some((a) => a.startsWith('s3:')));
    // (in any order: CDK packs a role's statements into its policy and an overflow policy by size)
    expect(s3.map((s) => [...s.actions].sort(byCodeUnit).join(',')).sort(byCodeUnit)).toStrictEqual([
      's3:AbortMultipartUpload',
      's3:DeleteObject,s3:DeleteObjectVersion',
      's3:GetObject',
      's3:ListBucketMultipartUploads',
      's3:ListBucketVersions',
    ]);
    const objectPaths = [...itemAt(s3, 0).resource.matchAll(/"\/([^"]*)"/g)].flatMap((match) => match[1] ?? []);
    // One workspace id per pattern (`ws_` + 26 `?`): IAM's `*` would also match `/`.
    const ws = `ws/ws_${'?'.repeat(26)}`;
    expect(objectPaths).toStrictEqual(['raw/*', 'silver/*', `${ws}/raw/*`, `${ws}/silver/*`, `${ws}/exports/*`]);
    expect(JSON.stringify(template.toJSON())).toContain(
      `"s3:prefix":["raw/*","silver/*","${ws}/raw/*","${ws}/silver/*","${ws}/exports/*"]`);
  });

  it('reads objects only under the product documents and the library\'s text (an erasure by email looks there)', () => {
    const reads = statements().filter((s) => s.effect === 'Allow' && s.actions.includes('s3:GetObject'));
    // A workspace's text uploads and extracted text (7.43.00); the deployment's extracted text only (7.48.00); the
    // Documents Library's extracted text, never an original (7.62.00).
    expect(reads.map((s) => [s.actions, [...s.resource.matchAll(/"\/([^"]*)"/g)].flatMap((match) => match[1] ?? [])]))
      .toStrictEqual([[['s3:GetObject'], [`ws/ws_${'?'.repeat(26)}/projects/*/product_docs/raw/*.md`,
        `ws/ws_${'?'.repeat(26)}/projects/*/product_docs/raw/*.txt`,
        `ws/ws_${'?'.repeat(26)}/projects/*/product_docs/extracted/*`, 'projects/*/product_docs/extracted/*',
        'library/*/extracted', `ws/ws_${'?'.repeat(26)}/library/*/extracted`]]]);
  });

  it('updates projects in two statements, each on the deployment\'s and one workspace\'s partitions of its rows only', () => {
    const updates = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('Projects')
      && s.actions.includes('dynamodb:UpdateItem'));
    expect(updates.map((s) => s.actions)).toStrictEqual([['dynamodb:UpdateItem'], ['dynamodb:UpdateItem']]);
    const ws = `WS#ws_${'?'.repeat(26)}`;
    const json = JSON.stringify(template.toJSON());
    // 7.48.00: no lineage pass Scans, so the marks are pinned to the project partitions (no longer any partition).
    expect(json).toContain(JSON.stringify({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PROJECT#*', `${ws}#PROJECT#*`] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'input_feedback_ids',
        'evidence_feedback_ids', 'input_feature_request_ids', 'evidence_updates', 'erased_evidence'] },
      StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] },
    }));
    expect(json).toContain(JSON.stringify({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PROJECT#*', 'DCOMMENTS#*', 'DOCSHARE#*', `${ws}#PROJECT#*`,
        `${ws}#DCOMMENTS#*`, `${ws}#DOCSHARE#*`] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'author', 'replies', 'status_by', 'audience',
        'created_by_name', 'revoked_by', 'revoked', 'owner_email', 'members', 'research_notes'] },
      StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] },
    }));
  });

  it('aborts open multipart uploads under each workspace\'s exports only, and lists the bucket\'s upload keys (no data)', () => {
    const s3 = statements().filter((s) => s.effect === 'Allow'
      && s.actions.some((a) => a === 's3:AbortMultipartUpload' || a === 's3:ListBucketMultipartUploads'));
    const ws = `ws/ws_${'?'.repeat(26)}`;
    // ListBucketMultipartUploads takes no s3:prefix condition: the bucket itself, unconditioned (retention-worker.ts).
    expect(s3.map((s) => [...s.resource.matchAll(/"\/([^"]*)"/g)].flatMap((match) => match[1] ?? [])))
      .toStrictEqual([[`${ws}/exports/*`], []]);
  });

  it('carries one Deny of its own: no delete of a workspace\'s S3 import originals (listed for review, never deleted)', () => {
    // Whole-file uploads are reached only by a whole-source erasure (in code); a workspace's import originals by none.
    const denies = statements().filter((s) => s.effect === 'Deny' && s.actions.some((a) => a.startsWith('s3:')));
    expect(denies.map((s) => [...s.actions].sort(byCodeUnit))).toStrictEqual([['s3:DeleteObject', 's3:DeleteObjectVersion']]);
    const objectPaths = [...itemAt(denies, 0).resource.matchAll(/"\/([^"]*)"/g)].flatMap((match) => match[1] ?? []);
    expect(objectPaths).toStrictEqual([`ws/ws_${'?'.repeat(26)}/raw/s3_import/*`]);
  });

  it('may invoke only itself, by an unqualified colon-form ARN', () => {
    expectSelfInvokeOnly(statements(), 'voc-retention-');
    expect(statements().filter((s) => s.actions.includes('lambda:InvokeFunction') && s.resource.includes('*'))).toStrictEqual([]);
  });

  it('cannot reach Bedrock, SQS, other tables or anything with a wildcard action', () => {
    const offenders = statements().filter((s) => s.actions.some((a) =>
      a.startsWith('bedrock:') || a.startsWith('sqs:') || a.endsWith(':*'))
      || ['Jobs', 'Memory', 'Agents', 'Conversations'].some((t) => s.resource.includes(t)));
    expect(offenders).toStrictEqual([]);
  });

  it('is handed no engineering table or user pool, and holds no grant there, without the engineering agents', () => {
    const variables = worker().Environment.Variables;
    for (const name of ['ENGINEERING_TABLE', 'AGENTS_TABLE', 'USER_POOL_ID']) expect(variables).not.toHaveProperty(name);
    expect(statements().filter((s) => s.resource.includes('Engineering') || s.actions.some((a) => a.startsWith('cognito-idp:'))))
      .toStrictEqual([]);
  });

  it('bundles the engineering memory\'s erasure and nothing else of the engineering tree (7.84.00)', () => {
    const excludes = [...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES, ...RETENTION_OWN_EXCLUDES];
    const ignored = (path: string) => IgnoreStrategy.git('/root', excludes).ignores(`/root/${path}`);
    for (const file of RETENTION_ENGINEERING_FILES) expect(ignored(file)).toBe(false);
    for (const kept of ['jobs/retention/handler.py', 'jobs/__init__.py', 'shared/aws.py']) expect(ignored(kept)).toBe(false);
    for (const out of ['engineering/agent_memory/store.py', 'engineering/agent_memory/model.py',
      'engineering/runtime/runs.py', 'engineering/connectors/identity.py', 'jobs/workspace_delete/handler.py',
      'api/settings_handler.py', 'agents/heartbeat/issues.py', 'engineering/agent_memory/test/test_store.py']) {
      expect(ignored(out)).toBe(true);
    }
  });

  it('runs daily in retention mode', () => {
    const rules = Object.entries(template.findResources('AWS::Events::Rule'))
      .filter(([id]) => id.startsWith('RetentionWorkerRetentionSchedule'))
      .map(([, rule]) => RuleSchema.parse(rule).Properties);
    expect(rules).toHaveLength(1);
    expect(itemAt(rules, 0).ScheduleExpression).toBe('cron(15 4 * * ? *)');
    expect(JSON.parse(itemAt(itemAt(rules, 0).Targets, 0).Input ?? '{}')).toStrictEqual({ mode: 'retention' });
  });
});

describe('voc-retention with -c engineeringAgents=true (7.84.00, projects 3g3-b)', () => {
  let engineering: Template;
  beforeAll(() => {
    engineering = synthProcessingTemplate({ withIndexes: true, context: { engineeringAgents: true } });
  });
  const engineeringWorker = () => findWorkerFunction(engineering, 'voc-retention-');
  const engineeringStatements = () => roleStatements(engineering, engineeringWorker().Role['Fn::GetAtt'][0]);
  const on = (table: string) => engineeringStatements().filter((s) => s.effect === 'Allow' && s.resource.includes(table)
    && s.actions.some((a) => a.startsWith('dynamodb:')));
  const keys = (partitions: string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions } });
  const noReturn = { StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] } };
  const specific = { StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' } };

  it('is handed voc-engineering, voc-agents and the user pool', () => {
    expect(Object.keys(engineeringWorker().Environment.Variables)).toStrictEqual(expect.arrayContaining([
      'ENGINEERING_TABLE', 'AGENTS_TABLE', 'USER_POOL_ID']));
  });

  it('reaches voc-agents\' issue claims only: their Query and an update of feedback_id and the mark', () => {
    expect(on('Agents').map((s) => [...s.actions].sort(byCodeUnit))).toStrictEqual([['dynamodb:Query'],
      ['dynamodb:UpdateItem']]);
    const json = JSON.stringify(engineering.toJSON());
    const attributes = { 'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'feedback_id',
      'engineering_run_id', 'erased_evidence'] } };
    expect(json).toContain(JSON.stringify({ ...keys(['ISSUE_RUN#default']), ...attributes, ...specific }));
    expect(json).toContain(JSON.stringify({ ...keys(['ISSUE_RUN#default']), ...attributes, ...noReturn }));
  });

  it('reads the engineering runs by their list and their META\'s feedback, and updates only that and the mark', () => {
    const json = JSON.stringify(engineering.toJSON());
    const attributes = { 'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'feedback', 'erased_evidence'] } };
    expect(json).toContain(JSON.stringify({ ...keys(['WS#default#RUNLIST#*', 'WS#default#RUN#*']), ...attributes, ...specific }));
    expect(json).toContain(JSON.stringify({ ...keys(['WS#default#RUN#*']), ...attributes, ...noReturn }));
  });

  it('erases the agents\' memory in its own partitions only: Query, the person\'s attributes, puts and deletes', () => {
    const byStatement = (a: unknown, b: unknown) => byCodeUnit(JSON.stringify(a), JSON.stringify(b));
    expect(on('Engineering').filter((s) => !s.resource.includes('Agents')).map((s) => [...s.actions].sort(byCodeUnit))
      .sort(byStatement)).toStrictEqual([['dynamodb:Query'], ['dynamodb:Query'], ['dynamodb:UpdateItem'],
      ['dynamodb:UpdateItem'], ['dynamodb:PutItem'], ['dynamodb:PutItem'], ['dynamodb:DeleteItem']].sort(byStatement));
  });

  it('pins the memory erasure\'s statements to its partitions and attributes', () => {
    const json = JSON.stringify(engineering.toJSON());
    expect(json).toContain(JSON.stringify(keys(['WS#default#AMEM#*'])));
    expect(json).toContain(JSON.stringify({ ...keys(['WS#default#AMEM#*']), 'ForAllValues:StringEquals': {
      'dynamodb:Attributes': ['pk', 'sk', 'author', 'prov_person', 'approved_by', 'by'] }, ...noReturn }));
    expect(json).toContain(JSON.stringify(keys(['AUDIT#tombstone#agent_memory_person', 'AUDIT#delete'])));
    // A re-keyed confirmation row is the memory partitions' only put: held to its attributes (7.84.00, S6).
    expect(json).toContain(JSON.stringify({ ...keys(['WS#default#AMEM#*']), 'ForAllValues:StringEquals': {
      'dynamodb:Attributes': ['pk', 'sk', 'source', 'comment_url', 'at'] } }));
  });

  it('looks the erased address up in the user pool with one AdminGetUser, never a listing', () => {
    const cognito = engineeringStatements().filter((s) => s.actions.some((a) => a.startsWith('cognito-idp:')));
    expect(cognito.map((s) => s.actions)).toStrictEqual([['cognito-idp:AdminGetUser']]);
    expect(cognito.every((s) => s.resource.includes('UserPool'))).toBe(true);
  });

  it('keeps every delete and put in the role\'s own inline policy, the managed ones reading and updating only', () => {
    const managed = retentionManaged(engineering);
    // What the role's own policy would hold, the part CDK split off included (none may be: 10,240 characters).
    const inline = [...Object.entries(engineering.findResources('AWS::IAM::Policy')),
      ...Object.entries(engineering.findResources('AWS::IAM::ManagedPolicy'))]
      .filter(([id]) => /^RetentionWorkerRetentionRole(DefaultPolicy|OverflowPolicy)/.test(id))
      .reduce((total, [, resource]) => total + resolvedSize(resource.Properties.PolicyDocument), 0);
    expect(managed.map(([id]) => id.replace(/[0-9A-F]{8}$/, '')).sort(byCodeUnit),
      `the role's own policy needs ${inline} of 10240 characters`).toStrictEqual([
      'RetentionWorkerRetentionEngineeringPolicy', 'RetentionWorkerRetentionReadsPolicy',
      'RetentionWorkerRetentionWalksPolicy']);
    expect(managed.flatMap(([, resource]) => allowedIn(resource)).filter((a) => /Delete|Put|BatchWrite/.test(a)))
      .toStrictEqual([]);
    const policy = (name: string) => allowedIn(managed.find(([id]) => id.startsWith(name))?.[1]);
    expect([...new Set(policy('RetentionWorkerRetentionEngineeringPolicy'))].sort(byCodeUnit)).toStrictEqual([
      'cognito-idp:AdminGetUser', 'dynamodb:Query', 'dynamodb:UpdateItem']);
    const [, engineeringPolicy] = managed.find(([id]) => id.startsWith('RetentionWorkerRetentionEngineeringPolicy')) ?? [];
    expect(JSON.stringify(engineeringPolicy)).toContain(`"Roles":[{"Ref":"${engineeringWorker().Role['Fn::GetAtt'][0]}"}]`);
    expect(overflowPolicies(engineering)).toStrictEqual([]);
  });

  it('reports the role\'s inline policy\'s size with the engineering agents, a margin under CDK\'s split', () => {
    const [, inline] = Object.entries(engineering.findResources('AWS::IAM::Policy'))
      .find(([id]) => id.startsWith('RetentionWorkerRetentionRoleDefaultPolicy')) ?? [];
    const size = resolvedSize(inline?.Properties.PolicyDocument);
    // The size as IAM counts it, ARN tokens at 90 characters: 7,958 since the reads policy (7.84.00). At 9,776 (the
    // slice's first layout) CDK split it, so the policy keeps at least 1,500 characters below that.
    expect(size, `the role's inline policy with the engineering agents: ${size} of 10240 characters`)
      .toBeLessThan(9776 - 1500);
    expect(overflowPolicies(engineering)).toStrictEqual([]);
  });

  it('keeps the role\'s inline policy under its size quota (10,240 characters once its ARNs resolve)', () => {
    for (const [build, synthesized] of [['default', template], ['engineering', engineering]] as const) {
      // The role's own policy and any part CDK split off it: what IAM would count as its inline policy.
      const size = [...Object.entries(synthesized.findResources('AWS::IAM::Policy')),
        ...Object.entries(synthesized.findResources('AWS::IAM::ManagedPolicy'))]
        .filter(([id]) => /^RetentionWorkerRetentionRole(DefaultPolicy|OverflowPolicy)/.test(id))
        .reduce((total, [, resource]) => total + resolvedSize(resource.Properties.PolicyDocument), 0);
      expect(size, `${build}: ${size} of 10240`).toBeLessThan(10240);
    }
  });

  it('keeps each managed policy under its size quota (6,144 characters once its ARNs resolve)', () => {
    for (const synthesized of [template, engineering]) {
      for (const [id, resource] of retentionManaged(synthesized)) {
        const size = resolvedSize(resource.Properties.PolicyDocument);
        console.info(`${id}: ${size} of 6144`);
        expect(size, id).toBeLessThan(6144);
      }
    }
  });
});
