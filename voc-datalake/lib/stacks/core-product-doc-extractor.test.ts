/**
 * The product-doc extractor's reach in a workspace (docs/multi-workspace.md, the project plan, 3f; 7.38.00).
 *
 * A workspace's upload is `ws/{ws}/projects/{id}/product_docs/raw/{doc}.{ext}`. Its notification rules are `ws/` with
 * one suffix per upload extension (the list voc-datalake/schemas/project-keys-cases.json holds, which the Python
 * suites hold to the upload boundary and to the handler), beside the deployment's `projects/` rule. Its grants:
 * voc-projects by key only (the document rows of `PROJECT#{id}` and one workspace's `WS#{ws}#PROJECT#{id}`, GetItem
 * and UpdateItem; a project id's claim, GetItem of its key and workspace id), a workspace's `META` status, and the
 * raw and extracted prefixes in one workspace's `ws/{one id}/`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { itemAt } from '../test-support/guards';
import {
  IamPolicySchema, WORKSPACE_STATUS_READ_CONDITION, isAttachedToRole, isAuditRowGuardStatement, statementActions,
} from '../test-support/iam-statements';
import { byCodeUnit } from '../utils/compare';
import { WORKSPACE_ID_PATTERN } from './core-buckets';
import { claudeRoleGrantOf, missingModelGrants } from '../test-support/bedrock-grants';
import { ALLOWED_MODEL_IDS } from '../utils/model-allowlist';
import {
  PRODUCT_DOC_MODEL_PARTITIONS, PRODUCT_DOC_PARTITIONS, PRODUCT_DOC_READ_ATTRIBUTES, PRODUCT_DOC_ROW_ATTRIBUTES,
  PRODUCT_DOC_UPLOAD_EXTENSIONS,
  PROJECT_CLAIM_READ_ATTRIBUTES,
} from './core-product-doc-extractor';

/** The key actions the extractor holds on the stack's key (`kmsKey.grantEncryptDecrypt`: its table reads and
 *  writes and its object reads and puts are all under that key). No grant on any other key. */
const KMS_ACTIONS = ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey',
  'kms:GenerateDataKeyWithoutPlaintext', 'kms:ReEncryptFrom', 'kms:ReEncryptTo'];

const CASES = z.object({
  upload_extensions: z.array(z.string()), doc_row_attributes: z.array(z.string()),
  doc_read_attributes: z.array(z.string()), model_rows: z.array(z.string()),
}).parse(JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'schemas', 'project-keys-cases.json'), 'utf8')));
const ONE = WORKSPACE_ID_PATTERN;

const NotificationsSchema = z.array(z.object({
  Events: z.array(z.string()),
  Filter: z.object({ Key: z.object({ FilterRules: z.array(z.object({ Name: z.string(), Value: z.string() })) }) }),
  LambdaFunctionArn: z.object({ 'Fn::GetAtt': z.array(z.string()) }),
}).partial({ Filter: true }));

/** The raw bucket's Lambda notification rules, each as `{events, rules, target}`. */
function notificationRules() {
  const notifications = Object.values(synthCoreTemplate().findResources('Custom::S3BucketNotifications'))
    .filter((r) => JSON.stringify(r.Properties?.BucketName ?? '').includes('RawDataBucket'));
  expect(notifications).toHaveLength(1);
  return NotificationsSchema.parse(itemAt(notifications, 0).Properties.NotificationConfiguration
    .LambdaFunctionConfigurations).map((config) => ({
    events: config.Events,
    rules: Object.fromEntries((config.Filter?.Key.FilterRules ?? []).map((rule) => [rule.Name, rule.Value])),
    target: String(config.LambdaFunctionArn['Fn::GetAtt'].at(0)),
  }));
}

/** The extractor role's Allow statements (its inline policy and any managed one), the audit-row Denies apart. */
function extractorStatements() {
  const template = synthCoreTemplate();
  const roleId = Object.keys(template.findResources('AWS::IAM::Role'))
    .filter((id) => id.startsWith('ProductDocExtractorLambdaServiceRole'));
  expect(roleId).toHaveLength(1);
  return [...Object.values(template.findResources('AWS::IAM::Policy')),
    ...Object.values(template.findResources('AWS::IAM::ManagedPolicy'))]
    .map((resource) => IamPolicySchema.parse(resource).Properties)
    .filter((properties) => isAttachedToRole(properties, itemAt(roleId, 0)))
    .flatMap((properties) => properties.PolicyDocument.Statement)
    .filter((statement) => !isAuditRowGuardStatement(statement) && (statement.Effect ?? 'Allow') === 'Allow')
    .map((statement) => ({ actions: [...statementActions(statement)].sort(byCodeUnit),
      resource: JSON.stringify(statement.Resource), condition: statement.Condition }));
}

/** The DynamoDB statements on one table (by its logical id's start), each `{actions, condition}`, sorted. */
function onTable(table: string) {
  return extractorStatements()
    .filter((s) => s.actions.some((action) => action.startsWith('dynamodb:')) && s.resource.includes(table))
    .map((s) => ({ actions: s.actions, index: s.resource.includes('/index/'), condition: s.condition }))
    .sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));
}

const keys = (partitions: readonly string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [...partitions] } });
/** An attribute-limited GetItem's condition (lib/utils/workspace-resolution-grants.ts `grantWorkspaceAttributeRead`). */
const attributesOnly = (partitions: readonly string[], attributes: readonly string[]) => ({
  ...keys(partitions),
  'ForAllValues:StringEquals': { 'dynamodb:Attributes': [...attributes] },
  StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
  Null: { 'dynamodb:Attributes': 'false' },
});

describe('the product-doc extractor and a workspace\'s uploads', () => {
  it('is notified of `ws/` objects with an upload extension, one rule each, beside the deployment\'s `projects/`', () => {
    expect([...PRODUCT_DOC_UPLOAD_EXTENSIONS]).toStrictEqual(CASES.upload_extensions);
    const rules = notificationRules();
    expect(rules.map((rule) => rule.rules)).toStrictEqual([
      { prefix: 'projects/' }, ...CASES.upload_extensions.map((extension) => ({ prefix: 'ws/', suffix: `.${extension}` }))]);
    expect(new Set(rules.flatMap((rule) => [...rule.events, rule.target.replace(/[0-9A-F]{8}$/, '')])))
      .toStrictEqual(new Set(['s3:ObjectCreated:*', 'ProductDocExtractorLambda']));
  });

  it('no two of those suffixes overlap (S3 refuses rules whose suffixes do)', () => {
    const suffixes = CASES.upload_extensions.map((extension) => `.${extension}`);
    expect(suffixes.filter((a) => suffixes.some((b) => a !== b && a.endsWith(b)))).toStrictEqual([]);
  });

  it('voc-projects: the project partitions (a document row\'s GetItem, its UpdateItem of its own attributes), and a claim\'s workspace id', () => {
    expect([[...PRODUCT_DOC_PARTITIONS], [...PROJECT_CLAIM_READ_ATTRIBUTES]]).toStrictEqual([
      ['PROJECT#*', `WS#${ONE}#PROJECT#*`], ['pk', 'sk', 'workspace_id']]);
    expect([[...PRODUCT_DOC_ROW_ATTRIBUTES], [...PRODUCT_DOC_READ_ATTRIBUTES]]).toStrictEqual(
      [CASES.doc_row_attributes, CASES.doc_read_attributes]);
    // Exactly these four: no read or write of any other row of the table, no index, no Query or Scan. A workspace's
    // record is read for its projected attributes only; the deployment's read stays the unprojected one it was.
    expect(onTable('ProjectsTable')).toStrictEqual([
      { actions: ['dynamodb:GetItem'], index: false, condition: keys(['PROJECT#*']) },
      { actions: ['dynamodb:GetItem'], index: false, condition: attributesOnly(['PROJECT_ID#*'], ['pk', 'sk', 'workspace_id']) },
      { actions: ['dynamodb:GetItem'], index: false,
        condition: attributesOnly([`WS#${ONE}#PROJECT#*`], CASES.doc_read_attributes) },
      { actions: ['dynamodb:UpdateItem'], index: false, condition: {
        ...keys(PRODUCT_DOC_PARTITIONS),
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': [...PRODUCT_DOC_ROW_ATTRIBUTES] } } },
    ]);
  });

  it('voc-workspaces: a workspace\'s `META` status only', () => {
    expect(onTable('WorkspacesTable')).toStrictEqual([
      { actions: ['dynamodb:GetItem'], index: false, condition: WORKSPACE_STATUS_READ_CONDITION }]);
  });

  it('voc-aggregates: GetItem of the two model rows only (the picks, the deployment\'s default)', () => {
    expect([...PRODUCT_DOC_MODEL_PARTITIONS]).toStrictEqual(CASES.model_rows);
    expect(onTable('AggregatesTable')).toStrictEqual([{ actions: ['dynamodb:GetItem'], index: false,
      condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': CASES.model_rows } } }]);
  });

  it('KMS: the stack\'s one key, with exactly the actions its reads and its writes need', () => {
    const kms = extractorStatements().filter((s) => s.actions.some((action) => action.startsWith('kms:')));
    expect(new Set(kms.flatMap((s) => s.actions))).toStrictEqual(new Set(KMS_ACTIONS));
    expect(kms.filter((s) => !s.resource.includes('VocKmsKey'))).toStrictEqual([]);
  });

  it('Bedrock: invoke on the allowlisted models only, through the stack\'s managed policies', () => {
    const bedrock = extractorStatements().filter((s) => s.actions.some((action) => action.startsWith('bedrock:')));
    expect(new Set(bedrock.flatMap((s) => s.actions))).toStrictEqual(new Set(['bedrock:InvokeModel']));
    const grant = claudeRoleGrantOf('Core', synthCoreTemplate().toJSON(), 'ProductDocExtractorLambdaServiceRole');
    expect(missingModelGrants([grant], ALLOWED_MODEL_IDS, 'global')).toStrictEqual([]);
    expect(grant.statements.flatMap((s) => s.resources).filter((arn) => arn.includes('*'))).toStrictEqual([]);
  });

  it('S3: GetObject of the raw uploads; put, and delete to take back, the extracted text; nothing else, no List', () => {
    const s3 = extractorStatements().filter((s) => s.actions.some((action) => action.startsWith('s3:')));
    const paths = (s: { resource: string }) => [...s.resource.matchAll(/\/((?:ws\/[^"]+\/)?projects\/[^"]+)"/g)]
      .map((found) => found[1] ?? '').sort(byCodeUnit);
    const raw = [`ws/${ONE}/projects/*/product_docs/raw/*`, 'projects/*/product_docs/raw/*'].sort(byCodeUnit);
    const extracted = [`ws/${ONE}/projects/*/product_docs/extracted/*`, 'projects/*/product_docs/extracted/*']
      .sort(byCodeUnit);
    expect(s3.map((s) => ({ actions: s.actions, paths: paths(s), condition: s.condition }))
      .sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)))).toStrictEqual([
      { actions: ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:PutObject'], paths: extracted, condition: undefined },
      { actions: ['s3:GetObject'], paths: raw, condition: undefined },
    ]);
  });
});
