/**
 * voc-retention's effective permissions (7.84.00). Every Allow and every Deny of the role (its inline policy and each
 * customer-managed policy attached to it, the audit-row guard's Denies included) evaluated together, an explicit Deny
 * winning, for each request of the list below: the audit puts, the deletes (DeleteItem, the participant erasure's
 * BatchWriteItem deletes, s3:DeleteObject and DeleteObjectVersion) and the updates, Queries and the directory read that
 * 7.84.00 moved into managed policies. The per-statement tests elsewhere leave the guard's Denies out; this one reads
 * them, so a Deny in one policy that cancels an Allow in another fails here. On the default build and the engineering
 * build, with the guard's own refusals (a change of an audit row, a forged audit put) checked too.
 *
 * The evaluator is IAM's for what these statements use: actions and resources as globs (`*` matching all), the
 * dynamodb:LeadingKeys and dynamodb:Attributes condition keys from the request, any other key as the request sends it
 * (`context`) and, when it sends none, as IAM treats a missing key (a negated operator, `…IfExists`, `Null: true` and
 * `ForAllValues` hold; any other fails). It refuses what it does not model: NotAction, NotResource, an unknown
 * operator, and a statement that limits the attributes of a request that lists none. Its own cases are at the end.
 */
import { describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import {
  IamPolicySchema, RawIamStatementSchema, globMatches, isAttachedToRole, managedPolicies,
} from '../test-support/iam-statements';
import { findWorkerFunction } from '../test-support/worker-function';

const WS = `ws_${'A'.repeat(26)}`;

/** One request the worker's code sends: an action, on a table row (`table`, its partition key, the attributes it
 *  names) or on one of the table's indexes (`index`, then `key` is the index's partition key), a raw-bucket object
 *  (`object`) or another resource (`fragment` of its ARN's token), with any other condition key it sends
 *  (`context`). */
interface Request {
  readonly what: string;
  readonly action: string;
  readonly table?: string;
  readonly index?: string;
  readonly key?: string;
  readonly attributes?: readonly string[];
  readonly object?: string;
  readonly fragment?: string;
  readonly context?: Readonly<Record<string, string>>;
}

/** A raw statement, as the evaluator reads it (NotAction and NotResource kept, to refuse them). */
const StatementSchema = RawIamStatementSchema;
type Statement = z.infer<typeof StatementSchema>;

/** Every statement of the retention role: its inline policy (and any split off it) and every managed policy attached. */
function retentionStatements(template: Template): Statement[] {
  const role = z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) })
    .parse(findWorkerFunction(template, 'voc-retention-').Role)['Fn::GetAtt'][0];
  const inline = Object.values(template.findResources('AWS::IAM::Policy'))
    .map((resource) => IamPolicySchema.parse(resource).Properties);
  return [...inline, ...managedPolicies(template)].filter((policy) => isAttachedToRole(policy, role))
    .flatMap((policy) => policy.PolicyDocument.Statement).map((statement) => StatementSchema.parse(statement));
}

const ConditionSchema = z.record(z.string(), z.record(z.string(), z.union([z.string(), z.array(z.string())])));
const NEGATED = /^(StringNot|ArnNot|NumericNotEquals|DateNotEquals)/;

/** The values the request sends for a condition key (none: undefined). */
function askedValues(conditionKey: string, request: Request): readonly string[] | undefined {
  if (conditionKey === 'dynamodb:LeadingKeys') return request.key === undefined ? undefined : [request.key];
  if (conditionKey === 'dynamodb:Attributes') return request.attributes;
  const sent = request.context?.[conditionKey];
  return sent === undefined ? undefined : [sent];
}

/** An operator's set qualifier (`ForAllValues:`, `ForAnyValue:`, or none). */
function setOf(operator: string): 'all' | 'any' | 'single' {
  if (operator.startsWith('ForAllValues:')) return 'all';
  if (operator.startsWith('ForAnyValue:')) return 'any';
  return 'single';
}

/** IAM's answer for a key the request does not send. */
function holdsWhenMissing(operator: string, base: string, values: readonly string[]): boolean {
  if (operator.endsWith('IfExists') || setOf(operator) === 'all') return true;
  if (setOf(operator) === 'any') return false;
  if (base === 'Null') return values.includes('true');
  return NEGATED.test(base);
}

/** One value's test by a base operator (the ones these statements use; any other throws). */
function valueHolds(base: string, operator: string, values: readonly string[], value: string): boolean {
  switch (base) {
    case 'StringEquals': return values.includes(value);
    case 'StringLike': return values.some((pattern) => globMatches(pattern, value));
    case 'StringNotEquals': return !values.includes(value);
    case 'StringNotLike': return !values.some((pattern) => globMatches(pattern, value));
    default: throw new Error(`the evaluation does not know the operator ${operator}`);
  }
}

/** One operator's test of one condition key, IAM's way (the module docstring). */
export function holds(operator: string, conditionKey: string, values: readonly string[], request: Request): boolean {
  const asked = askedValues(conditionKey, request);
  const base = operator.replace(/^For(All|Any)Values?:/, '').replace(/IfExists$/, '');
  if (asked === undefined || asked.length === 0) return holdsWhenMissing(operator, base, values);
  if (base === 'Null') return values.includes('false');
  const test = (value: string): boolean => valueHolds(base, operator, values, value);
  return setOf(operator) === 'all' ? asked.every(test) : asked.some(test);
}

/** The index a resource element names (`<table arn>/index/<name>`, a glob such as `*` too), or undefined for any other
 *  resource: an index's ARN is never a table's rows, a table's never an index's. */
function indexOf(element: unknown): string | undefined {
  const parts = z.object({ 'Fn::Join': z.tuple([z.string(), z.array(z.unknown())]) }).safeParse(element);
  const last = parts.success ? parts.data['Fn::Join'][1].at(-1) : element;
  if (typeof last !== 'string' || !last.includes('/index/')) return undefined;
  return last.slice(last.indexOf('/index/') + '/index/'.length);
}

function resourceMatches(element: unknown, request: Request): boolean {
  if (element === '*') return true;
  const index = indexOf(element);
  // An index's ARN reaches the requests of that index only (7.93.00: the gap check's Query), a table's none of them.
  if (index === undefined) {
    if (request.index !== undefined) return false;
  } else if (request.index === undefined || !globMatches(index, request.index)) {
    return false;
  }
  const text = JSON.stringify(element);
  if (request.table !== undefined) return new RegExp(`${request.table}[0-9A-F]{8}`).test(text);
  if (request.object !== undefined) {
    const globs = [...text.matchAll(/"\/([^"]*)"/g)].flatMap((match) => match[1] ?? []);
    return text.includes('RawData') && globs.some((glob) => globMatches(glob, request.object ?? ''));
  }
  return request.fragment !== undefined && text.includes(request.fragment);
}

/** Whether `statement` applies to `request`: its action, its resource and every condition. */
export function applies(statement: Statement, request: Request): boolean {
  if (statement.NotAction !== undefined || statement.NotResource !== undefined) {
    throw new Error(`the evaluation does not model NotAction or NotResource (${statement.Sid ?? 'a statement'})`);
  }
  const actions = [statement.Action ?? []].flat();
  if (!actions.some((action) => globMatches(action.toLowerCase(), request.action.toLowerCase()))) return false;
  if (![statement.Resource].flat().some((element) => resourceMatches(element, request))) return false;
  const tests = Object.entries(ConditionSchema.parse(statement.Condition ?? {})).flatMap(([operator, keys]) =>
    Object.entries(keys).map(([conditionKey, value]) => ({ operator, conditionKey, values: [value].flat() })));
  const others = tests.filter((test) => test.conditionKey !== 'dynamodb:Attributes');
  if (!others.every((test) => holds(test.operator, test.conditionKey, test.values, request))) return false;
  const limits = tests.filter((test) => test.conditionKey === 'dynamodb:Attributes');
  if (limits.length > 0 && request.attributes === undefined) {
    // Everything else of the statement applies: the request must say which attributes it names.
    throw new Error(`${request.what}: ${statement.Sid ?? 'a statement'} limits the attributes, and the request lists none`);
  }
  return limits.every((test) => holds(test.operator, test.conditionKey, test.values, request));
}

/** IAM's answer: how many Allows apply, and the Denies that apply (an explicit Deny wins). */
export function evaluate(statements: Statement[], request: Request): { allowedBy: number; deniedBy: string[] } {
  const matching = statements.filter((statement) => applies(statement, request));
  return {
    allowedBy: matching.filter((statement) => (statement.Effect ?? 'Allow') === 'Allow').length,
    deniedBy: matching.filter((statement) => statement.Effect === 'Deny').map((statement) => statement.Sid ?? '?'),
  };
}

const allowed = (answer: ReturnType<typeof evaluate>): boolean => answer.allowedBy > 0 && answer.deniedBy.length === 0;

const TOMBSTONE = ['pk', 'sk', 'legal_basis', 'actor', 'deleted_at'];
/** A prototype's pin form id (lambda/shared/prototype_pins.py `pin_form_id`: `pf_` and 16 hex). */
const PIN_FORM = 'pf_0123456789abcdef';
const DELETE_RECORD = ['pk', 'sk', 'kind', 'target', 'actor', 'reason', 'deleted_at'];
const NONE = { 'dynamodb:ReturnValues': 'NONE' };
const SPECIFIC = { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' };
/** The requests the worker's code makes on every build. */
const EVERY_BUILD: readonly Request[] = [
  { what: 'a feedback item', action: 'dynamodb:DeleteItem', table: 'Feedback', key: 'SOURCE#web' },
  { what: 'a workspace feedback item', action: 'dynamodb:DeleteItem', table: 'Feedback', key: `WS#${WS}#SOURCE#web` },
  { what: 'an item\'s tombstone', action: 'dynamodb:PutItem', table: 'Aggregates', key: 'AUDIT#tombstone#web' },
  { what: 'the run\'s audit row', action: 'dynamodb:PutItem', table: 'Aggregates', key: 'AUDIT#retention' },
  { what: 'a form test response', action: 'dynamodb:DeleteItem', table: 'Aggregates', key: 'FEEDBACK_FORM_TEST' },
  { what: 'a Radar review', action: 'dynamodb:DeleteItem', table: 'Radar', key: 'BRAND#acme' },
  { what: 'a re-keyed +1', action: 'dynamodb:PutItem', table: 'FeatureRequests', key: 'FR#fr_1' },
  { what: 'an erased +1', action: 'dynamodb:DeleteItem', table: 'FeatureRequests', key: 'FR#fr_1' },
  // 7.84.00's reads policy: the boards' reads and update, the memberships', the participants' update.
  { what: 'a board request\'s de-identification', action: 'dynamodb:UpdateItem', table: 'FeatureRequests', key: 'FR#fr_1' },
  { what: 'a board request\'s +1s', action: 'dynamodb:Query', table: 'FeatureRequests', key: 'FR#fr_1' },
  { what: 'the boards\' scan', action: 'dynamodb:Scan', table: 'FeatureRequests' },
  { what: 'the memberships\' scan', action: 'dynamodb:Scan', table: 'Workspaces' },
  { what: 'a membership\'s de-identification', action: 'dynamodb:UpdateItem', table: 'Workspaces', key: `WS#${WS}`,
    attributes: ['pk', 'sk', 'email', 'name'], context: NONE },
  { what: 'the workspace listing', action: 'dynamodb:Query', table: 'Workspaces', key: 'WORKSPACES' },
  { what: 'a participant\'s lists', action: 'dynamodb:UpdateItem', table: 'Participants', key: 'PERSON#pp_1',
    attributes: ['pk', 'sk', 'list_ids'], context: NONE },
  { what: 'a list\'s count', action: 'dynamodb:UpdateItem', table: 'Participants', key: `WS#${WS}#LIST#ls_1`,
    attributes: ['pk', 'sk', 'member_count'], context: NONE },
  // The participant erasure's audit puts and deletes.
  { what: 'a participant\'s tombstone', action: 'dynamodb:PutItem', table: 'Participants',
    key: 'AUDIT#tombstone#participant', attributes: TOMBSTONE },
  { what: 'a participant\'s delete record', action: 'dynamodb:PutItem', table: 'Participants', key: 'AUDIT#delete',
    attributes: DELETE_RECORD },
  { what: 'a participant', action: 'dynamodb:DeleteItem', table: 'Participants', key: 'PERSON#pp_1' },
  { what: 'a participant\'s guard', action: 'dynamodb:DeleteItem', table: 'Participants', key: 'EMAIL#abc' },
  { what: 'a workspace participant', action: 'dynamodb:DeleteItem', table: 'Participants', key: `WS#${WS}#PERSON#pp_1` },
  { what: 'a participant\'s tokens (a batch)', action: 'dynamodb:BatchWriteItem', table: 'Participants', key: 'TOKEN#t1' },
  { what: 'a participant\'s project links (a batch)', action: 'dynamodb:BatchWriteItem', table: 'Participants',
    key: 'PROJECT#pr_1' },
  { what: 'a participant\'s own rows (a batch)', action: 'dynamodb:BatchWriteItem', table: 'Participants',
    key: 'PERSON#pp_1' },
  { what: 'a workspace participant\'s own rows (a batch)', action: 'dynamodb:BatchWriteItem', table: 'Participants',
    key: `WS#${WS}#PERSON#pp_1` },
  // 7.93.00 (3g-d2): the gap check's page of live projects (their keys) and its lookup of one in PROJECT_IDS.
  { what: 'the project index\'s keys', action: 'dynamodb:Query', table: 'Projects', index: 'gsi1-by-type',
    key: 'TYPE#PROJECT', attributes: ['pk', 'sk'], context: SPECIFIC },
  { what: 'a page\'s registry rows (a batch)', action: 'dynamodb:BatchGetItem', table: 'Projects', key: 'PROJECT_IDS',
    attributes: ['pk', 'sk'] },
  // 7.96.00: a workspace's erasure finds its items by index, keys only (lambda/jobs/retention/item_walk.py), reads
  // each hit again from the table (the inline GetItem) and its workspace's META's created_at (where the walk starts).
  { what: 'a workspace day\'s keys', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi1-by-date',
    key: `WS#${WS}#DATE#2026-11-27`, attributes: ['pk', 'sk', 'gsi1pk', 'gsi1sk'], context: SPECIFIC },
  { what: 'a workspace id\'s keys', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi4-by-feedback-id',
    key: `WS#${WS}#FEEDBACK#0123456789abcdef0123456789abcdef`, attributes: ['pk', 'sk', 'gsi4pk'], context: SPECIFIC },
  // Filtered on the index by the erasure's own filter (its names may count in dynamodb:Attributes), keys returned.
  ...['author', 'csv_row_id', 'metadata'].map((field): Request => ({
    what: `a workspace day's keys filtered by ${field}`, action: 'dynamodb:Query', table: 'Feedback',
    index: 'gsi1-by-date', key: `WS#${WS}#DATE#2026-11-27`,
    attributes: ['pk', 'sk', 'gsi1pk', 'gsi1sk', field, 'source_platform'], context: SPECIFIC })),
  { what: 'a workspace id\'s keys filtered by its source id and source', action: 'dynamodb:Query', table: 'Feedback',
    index: 'gsi4-by-feedback-id', key: `WS#${WS}#FEEDBACK#0123456789abcdef0123456789abcdef`,
    attributes: ['pk', 'sk', 'gsi4pk', 'source_id', 'source_platform'], context: SPECIFIC },
  { what: 'a hit read again from the table', action: 'dynamodb:GetItem', table: 'Feedback', key: `WS#${WS}#SOURCE#web` },
  { what: 'a workspace\'s created_at', action: 'dynamodb:GetItem', table: 'Workspaces', key: `WS#${WS}`,
    attributes: ['pk', 'sk', 'created_at'], context: SPECIFIC },
  // 7.98.00 (3g-pin): an erasure by email's walk of the prototype pins (lambda/jobs/retention/pins.py): a project's
  // prototypes by Query (keys only), the scope's pin forms and each form's pins by Query, a pin's replies rewritten,
  // and its change recorded before and after (the projects walk's own records).
  { what: 'a deployment project\'s prototypes', action: 'dynamodb:Query', table: 'Projects', key: 'PROJECT#p1',
    attributes: ['pk', 'sk'], context: SPECIFIC },
  { what: 'a workspace project\'s prototypes', action: 'dynamodb:Query', table: 'Projects', key: `WS#${WS}#PROJECT#p1`,
    attributes: ['pk', 'sk'], context: SPECIFIC },
  ...['FEEDBACK_FORM', `WS#${WS}#FEEDBACK_FORM`].map((key): Request => ({
    what: `the pin forms of ${key}`, action: 'dynamodb:Query', table: 'Aggregates', key, attributes: ['pk', 'sk'],
    context: SPECIFIC })),
  ...[`PINS#${PIN_FORM}`, `WS#${WS}#PINS#${PIN_FORM}`].flatMap((key): Request[] => [
    { what: `the pins of ${key}`, action: 'dynamodb:Query', table: 'Aggregates', key,
      attributes: ['pk', 'sk', 'replies'], context: SPECIFIC },
    { what: `a pin's replies in ${key}`, action: 'dynamodb:UpdateItem', table: 'Aggregates', key,
      attributes: ['pk', 'sk', 'replies'], context: NONE },
  ]),
  ...['AUDIT#tombstone#deployment_projects', 'AUDIT#tombstone#workspace_projects'].map((key): Request => ({
    what: `a pin's record in ${key}`, action: 'dynamodb:PutItem', table: 'Aggregates', key,
    attributes: [...TOMBSTONE, 'source', 'store', 'mode', 'run_id', 'job_id', 'kind', 'action'] })),
  // Raw objects, each with both delete actions.
  ...['raw/web/2026/01/01/f1/0123456789abcdef.json', 'silver/web/f1/20260101T000000000000Z-0a.json',
    `ws/${WS}/raw/web/2026/01/01/f1/0a.json`, `ws/${WS}/silver/web/f1/20260101T000000000000Z-0a.json`,
    `ws/${WS}/exports/ex_1/workspace-export.zip`].flatMap((object) => ['s3:DeleteObject', 's3:DeleteObjectVersion']
    .map((action) => ({ what: `${action} of ${object}`, action, object }))),
];
/** And with -c engineeringAgents=true. */
const ENGINEERING: readonly Request[] = [
  { what: 'an agent memory tombstone', action: 'dynamodb:PutItem', table: 'Engineering',
    key: 'AUDIT#tombstone#agent_memory_person', attributes: TOMBSTONE },
  { what: 'an agent memory delete record', action: 'dynamodb:PutItem', table: 'Engineering', key: 'AUDIT#delete',
    attributes: DELETE_RECORD },
  { what: 'a re-keyed confirmation', action: 'dynamodb:PutItem', table: 'Engineering', key: 'WS#default#AMEM#REPO#c1',
    attributes: ['pk', 'sk', 'source', 'comment_url', 'at'] },
  { what: 'a person\'s memory row', action: 'dynamodb:DeleteItem', table: 'Engineering',
    key: 'WS#default#AMEM#PERSON#3f2a6c1e-0b7d-4c55-9a51-2d3e4f5a6b7c' },
  // 7.84.00's engineering policy: the reads, the attribute-held updates and the directory read.
  { what: 'a person\'s memory partition', action: 'dynamodb:Query', table: 'Engineering',
    key: 'WS#default#AMEM#PERSON#3f2a6c1e-0b7d-4c55-9a51-2d3e4f5a6b7c' },
  { what: 'a memory row\'s author', action: 'dynamodb:UpdateItem', table: 'Engineering', key: 'WS#default#AMEM#REPO#c1',
    attributes: ['pk', 'sk', 'author'], context: NONE },
  { what: 'the issue claims', action: 'dynamodb:Query', table: 'Agents', key: 'ISSUE_RUN#default',
    attributes: ['pk', 'sk', 'feedback_id', 'engineering_run_id', 'erased_evidence'], context: SPECIFIC },
  { what: 'a claim\'s mark', action: 'dynamodb:UpdateItem', table: 'Agents', key: 'ISSUE_RUN#default',
    attributes: ['pk', 'sk', 'feedback_id', 'erased_evidence'], context: NONE },
  { what: 'a month\'s runs list', action: 'dynamodb:Query', table: 'Engineering', key: 'WS#default#RUNLIST#2026-11',
    attributes: ['pk', 'sk'], context: SPECIFIC },
  { what: 'a run\'s META', action: 'dynamodb:Query', table: 'Engineering', key: 'WS#default#RUN#01JD0000000000000000000001',
    attributes: ['pk', 'sk', 'feedback', 'erased_evidence'], context: SPECIFIC },
  { what: 'a run\'s mark', action: 'dynamodb:UpdateItem', table: 'Engineering',
    key: 'WS#default#RUN#01JD0000000000000000000001', attributes: ['pk', 'sk', 'feedback', 'erased_evidence'],
    context: NONE },
  { what: 'the account the address names', action: 'cognito-idp:AdminGetUser', fragment: 'UserPool' },
];

/** What the worker may not do to voc-projects on any build (7.93.00, 3g-d2): no Scan (the fallback is gone), and the
 *  project index read for its keys, in the deployment's partition, with `SPECIFIC_ATTRIBUTES`, and nothing more. */
const PROJECTS_REFUSED: readonly Request[] = [
  { what: 'a Scan of the projects', action: 'dynamodb:Scan', table: 'Projects', attributes: ['pk', 'sk'],
    context: SPECIFIC },
  { what: 'a Scan of the projects naming no attribute', action: 'dynamodb:Scan', table: 'Projects', attributes: [] },
  { what: 'a project\'s owner through the index', action: 'dynamodb:Query', table: 'Projects', index: 'gsi1-by-type',
    key: 'TYPE#PROJECT', attributes: ['pk', 'sk', 'owner_email'], context: SPECIFIC },
  { what: 'whole rows through the index', action: 'dynamodb:Query', table: 'Projects', index: 'gsi1-by-type',
    key: 'TYPE#PROJECT', attributes: [], context: { 'dynamodb:Select': 'ALL_ATTRIBUTES' } },
  { what: 'a workspace\'s projects through the index', action: 'dynamodb:Query', table: 'Projects',
    index: 'gsi1-by-type', key: `WS#${WS}#TYPE#PROJECT`, attributes: ['pk', 'sk'], context: SPECIFIC },
  { what: 'a project\'s documents through the index', action: 'dynamodb:Query', table: 'Projects',
    index: 'gsi1-by-type', key: 'PROJECT#p1#DOCUMENTS', attributes: ['pk', 'sk'], context: SPECIFIC },
  { what: 'a project\'s META in a batch', action: 'dynamodb:BatchGetItem', table: 'Projects', key: 'PROJECT#p1',
    attributes: ['pk', 'sk'] },
  { what: 'a registry row\'s other attributes in a batch', action: 'dynamodb:BatchGetItem', table: 'Projects',
    key: 'PROJECT_IDS', attributes: ['pk', 'sk', 'created_at'] },
  { what: 'whole registry rows in a batch', action: 'dynamodb:BatchGetItem', table: 'Projects', key: 'PROJECT_IDS',
    attributes: [], context: { 'dynamodb:Select': 'ALL_ATTRIBUTES' } },
  // 7.100.00 (3h-S0): the switch row (`PROJECTS_SWITCH`) is written only by the operator's check, with the operator's
  // own credentials (scripts/projects/switch_projects.py), and the backfill marker (`DOCSHARE_IDS`) only by the
  // backfill: the worker writes neither, whatever attributes the request names.
  ...['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'].flatMap(
    (action): Request[] => ['PROJECTS_SWITCH', 'DOCSHARE_IDS'].map((key) => ({
      what: `${action} of ${key}`, action, table: 'Projects', key,
      attributes: ['pk', 'sk', 'switched_at', 'release', 'projects_checked', 'steps', 'marker_at', 'check',
        'applied_by'] }))),
];

/** What the worker may not do to the pins on any build (7.98.00, 3g-pin): find them by a Scan, or delete one (an erasure
 *  de-identifies a reply, never removes the pin). */
const PINS_REFUSED: readonly Request[] = [
  { what: 'a Scan of voc-aggregates for the pins', action: 'dynamodb:Scan', table: 'Aggregates' },
  { what: 'a pin\'s delete', action: 'dynamodb:DeleteItem', table: 'Aggregates', key: `PINS#${PIN_FORM}` },
  { what: 'a workspace pin\'s delete', action: 'dynamodb:DeleteItem', table: 'Aggregates',
    key: `WS#${WS}#PINS#${PIN_FORM}` },
  { what: 'a pin form\'s delete', action: 'dynamodb:DeleteItem', table: 'Aggregates', key: 'FEEDBACK_FORM' },
];

/** What the worker may not read of voc-feedback's indexes or a workspace's META on any build (7.96.00): a workspace's
 *  day and id partitions only, for their keys only, `SPECIFIC_ATTRIBUTES` required; never the deployment's
 *  partitions, another index, an attribute beyond the keys or whole rows. */
const FEEDBACK_INDEXES_REFUSED: readonly Request[] = [
  { what: 'the deployment\'s day', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi1-by-date',
    key: 'DATE#2026-11-27', attributes: ['pk', 'sk', 'gsi1pk', 'gsi1sk'], context: SPECIFIC },
  { what: 'the deployment\'s id', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi4-by-feedback-id',
    key: 'FEEDBACK#0123456789abcdef0123456789abcdef', attributes: ['pk', 'sk', 'gsi4pk'], context: SPECIFIC },
  { what: 'a workspace\'s category index', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi2-by-category',
    key: `WS#${WS}#CATEGORY#billing`, attributes: ['pk', 'sk', 'gsi2pk', 'gsi2sk'], context: SPECIFIC },
  { what: 'a workspace\'s channel index', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi5-by-channel',
    key: `WS#${WS}#CHANNEL#reviews`, attributes: ['pk', 'sk', 'gsi5pk', 'gsi1sk'], context: SPECIFIC },
  { what: 'a day\'s review texts', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi1-by-date',
    key: `WS#${WS}#DATE#2026-11-27`, attributes: ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'original_text'], context: SPECIFIC },
  { what: 'an id\'s review texts beside its filter', action: 'dynamodb:Query', table: 'Feedback',
    index: 'gsi4-by-feedback-id', key: `WS#${WS}#FEEDBACK#0123456789abcdef0123456789abcdef`,
    attributes: ['pk', 'sk', 'gsi4pk', 'source_id', 'source_platform', 'original_text'], context: SPECIFIC },
  { what: 'a filtered day\'s whole rows', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi1-by-date',
    key: `WS#${WS}#DATE#2026-11-27`, attributes: ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'author', 'source_platform'],
    context: { 'dynamodb:Select': 'ALL_ATTRIBUTES' } },
  { what: 'the deployment\'s day, filtered', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi1-by-date',
    key: 'DATE#2026-11-27', attributes: ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'author'], context: SPECIFIC },
  { what: 'a workspace\'s category index, filtered', action: 'dynamodb:Query', table: 'Feedback',
    index: 'gsi2-by-category', key: `WS#${WS}#CATEGORY#billing`, attributes: ['pk', 'sk', 'gsi2pk', 'gsi2sk', 'author'],
    context: SPECIFIC },
  { what: 'a day\'s whole rows', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi1-by-date',
    key: `WS#${WS}#DATE#2026-11-27`, attributes: [], context: { 'dynamodb:Select': 'ALL_ATTRIBUTES' } },
  { what: 'a day\'s keys without a projection', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi1-by-date',
    key: `WS#${WS}#DATE#2026-11-27`, attributes: ['pk', 'sk', 'gsi1pk', 'gsi1sk'],
    context: { 'dynamodb:Select': 'ALL_ATTRIBUTES' } },
  { what: 'an id\'s whole rows', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi4-by-feedback-id',
    key: `WS#${WS}#FEEDBACK#0123456789abcdef0123456789abcdef`, attributes: [],
    context: { 'dynamodb:Select': 'ALL_ATTRIBUTES' } },
  // A whole-item projection by the index's own word (both indexes project ALL), filtered or not.
  { what: 'a day\'s projected rows', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi1-by-date',
    key: `WS#${WS}#DATE#2026-11-27`, attributes: [], context: { 'dynamodb:Select': 'ALL_PROJECTED_ATTRIBUTES' } },
  { what: 'a filtered day\'s projected rows', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi1-by-date',
    key: `WS#${WS}#DATE#2026-11-27`, attributes: ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'author', 'source_platform'],
    context: { 'dynamodb:Select': 'ALL_PROJECTED_ATTRIBUTES' } },
  { what: 'an id\'s projected rows', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi4-by-feedback-id',
    key: `WS#${WS}#FEEDBACK#0123456789abcdef0123456789abcdef`, attributes: [],
    context: { 'dynamodb:Select': 'ALL_PROJECTED_ATTRIBUTES' } },
  { what: 'a filtered id\'s projected rows', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi4-by-feedback-id',
    key: `WS#${WS}#FEEDBACK#0123456789abcdef0123456789abcdef`,
    attributes: ['pk', 'sk', 'gsi4pk', 'source_id', 'source_platform'],
    context: { 'dynamodb:Select': 'ALL_PROJECTED_ATTRIBUTES' } },
  { what: 'an id\'s day keys', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi4-by-feedback-id',
    key: `WS#${WS}#FEEDBACK#0123456789abcdef0123456789abcdef`, attributes: ['pk', 'sk', 'gsi4pk', 'gsi1pk'],
    context: SPECIFIC },
  { what: 'a day partition on the id index', action: 'dynamodb:Query', table: 'Feedback', index: 'gsi4-by-feedback-id',
    key: `WS#${WS}#DATE#2026-11-27`, attributes: ['pk', 'sk', 'gsi4pk'], context: SPECIFIC },
  { what: 'a workspace\'s name', action: 'dynamodb:GetItem', table: 'Workspaces', key: `WS#${WS}`,
    attributes: ['pk', 'sk', 'name'], context: SPECIFIC },
  { what: 'a workspace\'s whole META', action: 'dynamodb:GetItem', table: 'Workspaces', key: `WS#${WS}`,
    attributes: [], context: { 'dynamodb:Select': 'ALL_ATTRIBUTES' } },
];

/** The guarded tables voc-retention writes audit rows in on each build, and those where it is held to its own audit
 *  partitions (voc-aggregates: any `AUDIT#*` row is its own to put, retention rows and tombstones; never to change). */
const CHANGES = ['dynamodb:DeleteItem', 'dynamodb:UpdateItem', 'dynamodb:BatchWriteItem'];
const changesOf = (tables: readonly string[]) => tables.flatMap((table) => CHANGES.map((action) => [table, action]));

describe.each([
  ['the default build', {}, EVERY_BUILD, ['Participants', 'Aggregates'], ['Participants']],
  ['the engineering build', { engineeringAgents: true }, [...EVERY_BUILD, ...ENGINEERING],
    ['Participants', 'Aggregates', 'Engineering'], ['Participants', 'Engineering']],
] as const)('voc-retention\'s effective permissions, %s', (_build, context, requests, guarded, heldToOwn) => {
  const statements = retentionStatements(synthProcessingTemplate({ withIndexes: true, context }));

  it.each(requests.map((request) => [request.what, request]))('allows %s and no Deny cancels it', (_what, request) => {
    const answer = evaluate(statements, request);
    expect(answer.deniedBy).toStrictEqual([]);
    expect(answer.allowedBy).toBeGreaterThan(0);
  });

  it.each([...PROJECTS_REFUSED, ...FEEDBACK_INDEXES_REFUSED, ...PINS_REFUSED].map((request) => [request.what, request]))('refuses %s', (_what, request) => {
    expect(allowed(evaluate(statements, request))).toBe(false);
  });

  it.each(changesOf(guarded))('%s: the guard still refuses %s of an audit row', (table, action) => {
    expect(allowed(evaluate(statements, { what: 'a change', action, table, key: 'AUDIT#delete', attributes: [] })))
      .toBe(false);
  });

  it.each(heldToOwn)('%s: the guard still refuses a forged audit put', (table) => {
    expect(allowed(evaluate(statements, { what: 'a forged row', action: 'dynamodb:PutItem', table, key: 'AUDIT#WS#x',
      attributes: ['pk', 'sk'] }))).toBe(false);
  });
});

describe('the evaluator', () => {
  const request: Request = { what: 'a put', action: 'dynamodb:PutItem', table: 'Things', key: 'AUDIT#delete' };
  const table = { 'Fn::GetAtt': ['ThingsAB12CD34', 'Arn'] };
  const index = { 'Fn::Join': ['', [table, '/index/*']] };
  const limited: Statement = { Effect: 'Allow', Action: 'dynamodb:PutItem', Resource: table,
    Condition: { 'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk'] } } };
  const sendsSelect: Request = { ...request, context: SPECIFIC };

  it.each([
    // A key the request does not send: negated operators, Null true, IfExists and ForAllValues hold.
    ['a negated operator on a missing key', 'StringNotEquals', 'aws:SourceVpc', ['vpc-1'], request, true],
    ['ArnNot on a missing key', 'ArnNotLike', 'aws:SourceArn', ['arn:*'], request, true],
    ['ForAnyValue on a missing key', 'ForAnyValue:StringNotLike', 'dynamodb:Attributes', ['x'], request, false],
    ['Null true on a missing key', 'Null', 'aws:SourceVpc', ['true'], request, true],
    ['Null false on a missing key', 'Null', 'aws:SourceVpc', ['false'], request, false],
    ['IfExists on a missing key', 'StringEqualsIfExists', 'dynamodb:ReturnValues', ['NONE'], request, true],
    ['ForAllValues on a missing key', 'ForAllValues:StringEquals', 'dynamodb:Attributes', ['pk'], request, true],
    ['a positive operator on a missing key', 'StringEquals', 'dynamodb:Select', ['SPECIFIC_ATTRIBUTES'], request, false],
    // Keys the request sends.
    ['StringLike on a sent key', 'ForAnyValue:StringLike', 'dynamodb:LeadingKeys', ['AUDIT#*'], request, true],
    ['StringNotEquals on a sent key', 'ForAnyValue:StringNotEquals', 'dynamodb:LeadingKeys', ['AUDIT#delete'], request,
      false],
    ['a context key it sends', 'StringEquals', 'dynamodb:Select', ['SPECIFIC_ATTRIBUTES'], sendsSelect, true],
  ] as const)('holds %s as IAM does', (_what, operator, conditionKey, values, asked, expected) => {
    expect(holds(operator, conditionKey, values, asked)).toBe(expected);
  });

  it('throws on an operator it does not model', () => {
    expect(() => holds('NumericLessThan', 'dynamodb:LeadingKeys', ['1'], request)).toThrow(/operator/);
  });

  it.each([
    ['a Deny on a key the request does not send', { Effect: 'Deny', Action: 'dynamodb:PutItem', Resource: table,
      Condition: { StringNotEquals: { 'aws:SourceVpc': 'vpc-1' } } }, request, true],
    ['a resource of *', { Effect: 'Allow', Action: 'dynamodb:PutItem', Resource: '*' }, request, true],
    ['an action glob *Item', { Effect: 'Allow', Action: 'dynamodb:*Item', Resource: '*' }, request, true],
    ['an action glob Delete* to a put', { Effect: 'Allow', Action: 'dynamodb:Delete*', Resource: '*' }, request, false],
    ['an action glob Delete* to a delete', { Effect: 'Allow', Action: 'dynamodb:Delete*', Resource: '*' },
      { ...request, action: 'dynamodb:DeleteItem' }, true],
    ['an index ARN alone', { Effect: 'Allow', Action: 'dynamodb:PutItem', Resource: [index] }, request, false],
    ['the table beside its index', { Effect: 'Allow', Action: 'dynamodb:PutItem', Resource: [table, index] }, request,
      true],
    ['an attribute limit the request keeps', limited, { ...request, attributes: ['pk', 'sk'] }, true],
    ['an attribute limit the request passes', limited, { ...request, attributes: ['pk', 'sk', 'other'] }, false],
  ] as const)('applies %s as IAM does', (_what, statement, asked, expected) => {
    expect(applies(statement, asked)).toBe(expected);
  });

  it.each([
    ['NotResource', { Effect: 'Allow', Action: 'dynamodb:PutItem', NotResource: 'x' }, /Not/],
    ['NotAction', { Effect: 'Allow', NotAction: 'dynamodb:GetItem', Resource: '*' }, /Not/],
    ['an attribute limit on a request that lists none', limited, /limits the attributes/],
  ] as const)('refuses %s', (_what, statement, message) => {
    expect(() => applies(statement, request)).toThrow(message);
  });
});
