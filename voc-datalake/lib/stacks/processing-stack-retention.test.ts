/**
 * voc-retention — the per-source retention / erasure worker (retention-worker.ts,
 * docs/source-policies.md). The one role allowed to delete customer data, so its
 * grants are pinned EXACTLY: any widening (a Put on feedback, a bucket-wide delete,
 * a delete on aggregates) fails here.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { itemAt } from '../test-support/guards';
import { allowedActions, roleStatements } from '../test-support/iam-statements';
import { byCodeUnit } from '../utils/compare';
import { expectSelfInvokeOnly, findWorkerFunction } from '../test-support/worker-function';

const RuleSchema = z.object({
  Properties: z.object({
    ScheduleExpression: z.string(),
    Targets: z.array(z.object({ Input: z.string().optional() })),
  }),
});

let template: Template;
beforeAll(() => { template = synthProcessingTemplate({ withIndexes: true }); });

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
    ]));
    expect(variables).not.toHaveProperty('RETENTION_FUNCTION');
  });

  it('holds exactly GetItem/Query/Scan/DeleteItem on feedback — never Put, Update or BatchWrite', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'Feedback'))
      .toStrictEqual(['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan']);
  });

  it('holds exactly Get/Put/Update/Query plus the tombstone batches on aggregates — never a delete', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'Aggregates')).toStrictEqual([
      'dynamodb:BatchGetItem', 'dynamodb:GetItem', 'dynamodb:PutItem',
      'dynamodb:Query', 'dynamodb:UpdateItem',
    ]);
  });

  it('holds exactly Scan/DeleteItem on radar, plus the version bump pinned to SETTINGS#radar', () => {
    const radar = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('Radar')
      && s.actions.some((a) => a.startsWith('dynamodb:')));
    expect(radar.map((s) => [...s.actions].sort(byCodeUnit).join(','))).toStrictEqual([
      'dynamodb:DeleteItem,dynamodb:Scan', 'dynamodb:UpdateItem',
    ]);
    expect(JSON.stringify(template.toJSON())).toContain('"dynamodb:LeadingKeys":["SETTINGS#radar"]');
  });

  it('holds exactly Scan/UpdateItem on projects, and Query of its project partitions — never deletes or puts', () => {
    expect(allowedActions(statements(), 'dynamodb:', 'Projects'))
      .toStrictEqual(['dynamodb:Query', 'dynamodb:Scan', 'dynamodb:UpdateItem']);
    const queries = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('Projects')
      && s.actions.includes('dynamodb:Query'));
    // Query alone, on the table only: of any one workspace id's partitions (7.43.00) and of the deployment's
    // (7.44.00). No index: a deleted project's META is off gsi1-by-type, so the deployment's registry lists them.
    expect(queries.map((s) => [s.actions, s.resource.includes('/index/')]))
      .toStrictEqual([[['dynamodb:Query'], false], [['dynamodb:Query'], false]]);
  });

  it('queries exactly these project partitions: one workspace id\'s and the deployment\'s, its registries included', () => {
    const ws = `WS#ws_${'?'.repeat(26)}`;
    const json = JSON.stringify(template.toJSON());
    expect(json).toContain(JSON.stringify({ 'ForAllValues:StringLike': {
      'dynamodb:LeadingKeys': [`${ws}#PROJECT_IDS`, `${ws}#PROJECT#*`, `${ws}#DCOMMENTS#*`, `${ws}#DOCSHARE_IDS`,
        `${ws}#DOCSHARE#*`],
    } }));
    // The deployment's: its own partitions and its registries, each read only for the attributes the erasure and
    // the lineage marks read (7.44.00).
    expect(json).toContain(JSON.stringify({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PROJECT#*', 'DCOMMENTS#*', 'DOCSHARE#*', 'PROJECT_IDS',
        'DOCSHARE_IDS', 'COMMENT_SERIES_IDS'] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'author', 'replies', 'status_by', 'audience',
        'created_by_name', 'revoked_by', 'revoked', 'project_id', 'owner_email', 'members', 'research_notes',
        's3_raw_key', 'content_type', 'status', 's3_extracted_key', 'filename', 'deleted_at', 'deletion_started_at',
        'completed_at', 'release', 'links_found', 'series_found', 'projects_found', 'input_feedback_ids', 'evidence_feedback_ids',
        'input_feature_request_ids', 'erased_evidence'] },
      // A Query naming no attribute would pass ForAllValues and read whole rows: SPECIFIC_ATTRIBUTES is required.
      StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
    }));
  });

  it('asks for no returned values on its attribute-limited updates: the two on projects and the membership one', () => {
    // An UpdateItem limited to some attributes could otherwise read the whole row back (ALL_OLD, ALL_NEW).
    const policy = JSON.stringify(template.toJSON().Resources);
    const noReturn = JSON.stringify({ StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] } }).slice(1, -1);
    expect(policy.split(noReturn).length - 1).toBe(3);
    const limited = statements().filter((s) => s.effect === 'Allow' && s.actions.includes('dynamodb:UpdateItem')
      && (s.resource.includes('Projects') || s.resource.includes('Workspaces')));
    expect(limited).toHaveLength(3);
  });

  it('scans projects on the table only, for the attributes the backfill\'s Scan projects (7.44.00)', () => {
    const scans = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('Projects')
      && s.actions.includes('dynamodb:Scan'));
    expect(scans.map((s) => [s.actions, s.resource.includes('/index/')])).toStrictEqual([[['dynamodb:Scan'], false]]);
    expect(JSON.stringify(template.toJSON())).toContain(JSON.stringify({
      StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'workspace_id', 'project_id', 'series_id',
        'created_at'] },
    }));
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
    expect(s3.map((s) => [...s.actions].sort(byCodeUnit).join(','))).toStrictEqual([
      's3:DeleteObject,s3:DeleteObjectVersion',
      's3:GetObject',
      's3:ListBucketVersions',
      's3:AbortMultipartUpload',
      's3:ListBucketMultipartUploads',
    ]);
    const objectPaths = [...itemAt(s3, 0).resource.matchAll(/"\/([^"]*)"/g)].flatMap((match) => match[1] ?? []);
    // One workspace id per pattern (`ws_` + 26 `?`): IAM's `*` would also match `/`.
    const ws = `ws/ws_${'?'.repeat(26)}`;
    expect(objectPaths).toStrictEqual(['raw/*', 'silver/*', `${ws}/raw/*`, `${ws}/silver/*`, `${ws}/exports/*`]);
    expect(JSON.stringify(template.toJSON())).toContain(
      `"s3:prefix":["raw/*","silver/*","${ws}/raw/*","${ws}/silver/*","${ws}/exports/*"]`);
  });

  it('reads objects only under the product documents (an erasure by email looks for the address there)', () => {
    const reads = statements().filter((s) => s.effect === 'Allow' && s.actions.includes('s3:GetObject'));
    // A workspace's text uploads and extracted text (7.43.00); the deployment's extracted text only (7.44.00).
    expect(reads.map((s) => [s.actions, [...s.resource.matchAll(/"\/([^"]*)"/g)].flatMap((match) => match[1] ?? [])]))
      .toStrictEqual([[['s3:GetObject'], [`ws/ws_${'?'.repeat(26)}/projects/*/product_docs/raw/*.md`,
        `ws/ws_${'?'.repeat(26)}/projects/*/product_docs/raw/*.txt`,
        `ws/ws_${'?'.repeat(26)}/projects/*/product_docs/extracted/*`, 'projects/*/product_docs/extracted/*']]]);
  });

  it('updates projects in two statements, each on the deployment\'s and one workspace\'s partitions of its rows only', () => {
    const updates = statements().filter((s) => s.effect === 'Allow' && s.resource.includes('Projects')
      && s.actions.includes('dynamodb:UpdateItem'));
    expect(updates.map((s) => s.actions)).toStrictEqual([['dynamodb:UpdateItem'], ['dynamodb:UpdateItem']]);
    const ws = `WS#ws_${'?'.repeat(26)}`;
    const json = JSON.stringify(template.toJSON());
    // 7.44.00: no lineage pass Scans, so the marks are pinned to the project partitions (no longer any partition).
    expect(json).toContain(JSON.stringify({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PROJECT#*', `${ws}#PROJECT#*`] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'input_feedback_ids',
        'evidence_feedback_ids', 'input_feature_request_ids', 'erased_evidence'] },
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

  it('runs daily in retention mode', () => {
    const rules = Object.entries(template.findResources('AWS::Events::Rule'))
      .filter(([id]) => id.startsWith('RetentionWorkerRetentionSchedule'))
      .map(([, rule]) => RuleSchema.parse(rule).Properties);
    expect(rules).toHaveLength(1);
    expect(itemAt(rules, 0).ScheduleExpression).toBe('cron(15 4 * * ? *)');
    expect(JSON.parse(itemAt(itemAt(rules, 0).Targets, 0).Input ?? '{}')).toStrictEqual({ mode: 'retention' });
  });
});
