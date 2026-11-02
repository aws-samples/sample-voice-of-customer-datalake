/**
 * Exact grants: the CDK grant wildcards (cdk-nag `AwsSolutions-IAM5`) rewritten to the actions and index ARNs
 * the platform uses, on every identity policy of the app, in one place instead of at ~130 grant call sites.
 *
 * What it rewrites, in `Allow` statements only (a `Deny` keeps its wildcard: a narrower deny is weaker):
 *
 *   - `kms:GenerateDataKey*` → `kms:GenerateDataKey`; `kms:ReEncrypt*` → nothing. S3 SSE-KMS, SQS SSE-KMS and
 *     Secrets Manager need only `kms:GenerateDataKey` + `kms:Decrypt` from the caller (sources in
 *     {@link KMS_SOURCES}). DynamoDB lists `kms:GenerateDataKeyWithoutPlaintext`, `kms:ReEncryptFrom` and
 *     `kms:ReEncryptTo` among the permissions it needs on a customer managed key, so a policy that grants any
 *     `dynamodb:` action keeps exactly those, ONLY through DynamoDB (`kms:ViaService`
 *     `dynamodb.<region>.amazonaws.com`): the role itself cannot call them. The asymmetric data-key-pair
 *     variants (`kms:GenerateDataKeyPair*`) are dropped: no integrated service uses them for SSE.
 *   - S3 bucket grants: `s3:GetObject*` → `s3:GetObject` (GetObject, HeadObject, presigned GETs, ranged
 *     downloads and a copy source; no code reads a VersionId, a tag or an ACL), `s3:List*` → `s3:ListBucket`
 *     (ListObjectsV2, and a 404 rather than a 403 from HeadObject), `s3:DeleteObject*` → `s3:DeleteObject`
 *     (the one role that deletes versions, voc-retention, holds `s3:DeleteObjectVersion` explicitly),
 *     `s3:GetBucket*` and `s3:Abort*` → nothing (no code calls a GetBucket* API or uploads in parts: every
 *     writer is a single PutObject or a presigned PUT). CDK-owned handlers that do need some of them are
 *     listed in {@link CDK_HANDLER_NEEDS}.
 *   - `<table arn>/index/*` → one `<table arn>/index/<name>` per GSI / LSI of THAT table, read from its
 *     CfnTable (the resource token is followed back through its Reference, so a cross-stack grant keeps its
 *     export). A resource whose table cannot be found is left as it is, so cdk-nag still reports it.
 *
 * How. Each CfnPolicy's document is wrapped at the END of the app (bin/voc-datalake.ts) in a resolvable that
 * renders the original L2 PolicyDocument (statement minimization, `@aws-cdk/aws-iam:minimizePolicies`, and
 * its post-processing still apply) and rewrites the rendered statements while their tokens are still
 * unresolved. A statement added to a wrapped policy after the call is rewritten too (the rewrite happens at
 * resolution), but a policy CREATED after it is not: CDK creates a role's default policy on its first grant, so
 * call it once every stack is built. cdk-nag reads the same resolved document, so it sees the exact grants.
 */
import { Reference, Stack, Tokenization, type IResolvable, type IResolveContext } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IConstruct } from 'constructs';
import { z } from 'zod';

/** The grant wildcards this module replaces. */
export type GrantWildcard =
  | 'kms:GenerateDataKey*' | 'kms:ReEncrypt*'
  | 's3:GetObject*' | 's3:GetBucket*' | 's3:List*' | 's3:Abort*' | 's3:DeleteObject*';

/** Actions a CDK handler needs beyond {@link EXACT_ACTIONS}, by the wildcard its grant used to carry them in. */
export type GrantNeeds = Partial<Record<GrantWildcard, readonly string[]>>;

/** What each wildcard becomes for every role. */
export const EXACT_ACTIONS: Readonly<Record<GrantWildcard, readonly string[]>> = {
  'kms:GenerateDataKey*': ['kms:GenerateDataKey'],
  'kms:ReEncrypt*': [],
  's3:GetObject*': ['s3:GetObject'],
  's3:GetBucket*': [],
  's3:List*': ['s3:ListBucket'],
  's3:Abort*': [],
  's3:DeleteObject*': ['s3:DeleteObject'],
};

/** What each KMS wildcard keeps for a role that uses DynamoDB, callable only through DynamoDB. */
export const DYNAMODB_KMS_ACTIONS: Readonly<Partial<Record<GrantWildcard, readonly string[]>>> = {
  'kms:GenerateDataKey*': ['kms:GenerateDataKeyWithoutPlaintext'],
  'kms:ReEncrypt*': ['kms:ReEncryptFrom', 'kms:ReEncryptTo'],
};

/** AWS documentation for the KMS lists above. */
export const KMS_SOURCES = [
  'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/encryption.usagenotes.html',
  'https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html#require-sse-kms',
  'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-key-management.html',
  'https://docs.aws.amazon.com/secretsmanager/latest/userguide/security-encryption.html',
] as const;

/**
 * CDK-owned Lambda handlers (matched by the construct id CDK gives the singleton function) and what their own
 * code calls beyond {@link EXACT_ACTIONS}. BucketDeployment (aws-s3-deployment bucket-deployment-handler):
 * `get_bucket_tagging` before a delete (s3:GetBucketTagging) and `aws s3 sync`, which uploads a file of 8 MB
 * or more in parts and aborts a failed one (s3:AbortMultipartUpload); s3:GetBucketLocation is kept because the
 * AWS CLI's region lookup is not ours to audit.
 */
export const CDK_HANDLER_NEEDS: readonly { readonly idPrefix: string; readonly needs: GrantNeeds }[] = [
  {
    idPrefix: 'Custom::CDKBucketDeployment',
    needs: { 's3:GetBucket*': ['s3:GetBucketLocation', 's3:GetBucketTagging'], 's3:Abort*': ['s3:AbortMultipartUpload'] },
  },
];

const WILDCARDS = new Set<string>(Object.keys(EXACT_ACTIONS));
const isGrantWildcard = (action: string): action is GrantWildcard => WILDCARDS.has(action);
const INDEX_WILDCARD = '/index/*';

const StatementSchema = z.looseObject({
  Effect: z.string().optional(),
  Action: z.union([z.string(), z.array(z.string())]).optional(),
  Resource: z.unknown().optional(),
  Condition: z.unknown().optional(),
});
type Statement = z.infer<typeof StatementSchema>;
const RenderedDocumentSchema = z.looseObject({ Statement: z.array(StatementSchema).optional() });
const IndexListSchema = z.array(z.looseObject({ indexName: z.string() })).optional();

const actionsOf = (statement: Statement): string[] =>
  typeof statement.Action === 'string' ? [statement.Action] : statement.Action ?? [];

/** The needs of the CDK handler `policy` belongs to, if any. */
const needsFor = (policy: IConstruct): GrantNeeds[] => policy.node.scopes.flatMap((scope) =>
  CDK_HANDLER_NEEDS.filter((entry) => scope.node.id.startsWith(entry.idPrefix)).map((entry) => entry.needs));

/** The exact actions replacing `actions`' wildcards; `extra` gets the DynamoDB-only KMS actions. */
function exactActions(actions: readonly string[], needs: readonly GrantNeeds[], extra: Set<string>): string[] {
  const out = new Set<string>();
  for (const action of actions) {
    if (!isGrantWildcard(action)) {
      out.add(action);
      continue;
    }
    EXACT_ACTIONS[action].forEach((exact) => out.add(exact));
    needs.forEach((need) => need[action]?.forEach((exact) => out.add(exact)));
    DYNAMODB_KMS_ACTIONS[action]?.forEach((exact) => extra.add(exact));
  }
  return [...out];
}

/** The CfnTable a `<table arn>/index/*` string names, or undefined. */
function tableOf(resource: string): dynamodb.CfnTable | undefined {
  const fragments = Tokenization.reverseString(resource);
  if (fragments.length !== 2 || fragments.tokens.length !== 1) return undefined;
  const token = fragments.firstToken;
  if (!Reference.isReference(token) || !(token.target instanceof dynamodb.CfnTable)) return undefined;
  return token.target;
}

/** The index names of `table` (its GSIs, then its LSIs). */
function indexNames(table: dynamodb.CfnTable): string[] {
  const stack = Stack.of(table);
  return [table.globalSecondaryIndexes, table.localSecondaryIndexes]
    .flatMap((list) => IndexListSchema.parse(stack.resolve(list)) ?? [])
    .map((index) => index.indexName);
}

/**
 * A `<table arn>/index/*` string, or undefined. CDK's table grants hand the index ARN over as a Lazy (it is
 * `Aws.NO_VALUE` for a table without indexes), so a resource that is one bare token is resolved ONE level in
 * the current context: the result still carries the table ARN's token, never a resolved string.
 */
function indexWildcard(resource: unknown, context: IResolveContext): string | undefined {
  if (typeof resource !== 'string') return undefined;
  if (resource.endsWith(INDEX_WILDCARD)) return resource;
  const fragments = Tokenization.reverseString(resource);
  const token = fragments.firstToken;
  if (fragments.length !== 1 || token === undefined || Reference.isReference(token)) return undefined;
  const produced: unknown = token.resolve(context);
  return typeof produced === 'string' && produced.endsWith(INDEX_WILDCARD) ? produced : undefined;
}

/** `resource`, or one ARN per index of its table when it is a `<table arn>/index/*` wildcard. */
function exactResources(resource: unknown, context: IResolveContext): unknown {
  const wildcard = indexWildcard(resource, context);
  const table = wildcard === undefined ? undefined : tableOf(wildcard);
  if (wildcard === undefined || table === undefined) return resource;
  const prefix = wildcard.slice(0, -1);
  return indexNames(table).map((name) => `${prefix}${name}`);
}

function rewriteResource(resource: unknown, context: IResolveContext): unknown {
  if (!Array.isArray(resource)) {
    const exact = exactResources(resource, context);
    return Array.isArray(exact) && exact.length === 1 ? exact[0] : exact;
  }
  return resource.flatMap((entry) => {
    const exact = exactResources(entry, context);
    return Array.isArray(exact) ? exact : [exact];
  });
}

const isEmptyResource = (resource: unknown) => Array.isArray(resource) && resource.length === 0;

interface Rewritten { readonly statement: Statement | null; readonly dynamoKms: readonly string[] }

function rewriteStatement(statement: Statement, needs: readonly GrantNeeds[], context: IResolveContext): Rewritten {
  if ((statement.Effect ?? 'Allow') !== 'Allow' || statement.Action === undefined) {
    return { statement, dynamoKms: [] };
  }
  const extra = new Set<string>();
  const actions = exactActions(actionsOf(statement), needs, extra);
  const resource = rewriteResource(statement.Resource, context);
  // A statement with a condition keeps it on what it grants; its DynamoDB extras would need both conditions.
  const dynamoKms = statement.Condition === undefined ? [...extra] : [];
  if (actions.length === 0 || isEmptyResource(resource)) return { statement: null, dynamoKms };
  return { statement: { ...statement, Action: actions.length === 1 ? actions[0] : actions, Resource: resource }, dynamoKms };
}

const usesDynamoDb = (statements: readonly Statement[]) =>
  statements.some((statement) => (statement.Effect ?? 'Allow') === 'Allow'
    && actionsOf(statement).some((action) => action.startsWith('dynamodb:')));

/** The rendered document with every grant wildcard replaced (see the module comment). */
function rewriteRenderedDocument(rendered: unknown, policy: IConstruct, context: IResolveContext): unknown {
  const parsed = RenderedDocumentSchema.safeParse(rendered);
  if (!parsed.success || parsed.data.Statement === undefined) return rendered;
  const needs = needsFor(policy);
  const statements = parsed.data.Statement;
  const viaDynamoDb = usesDynamoDb(statements);
  const out: Statement[] = [];
  for (const statement of statements) {
    const { statement: exact, dynamoKms } = rewriteStatement(statement, needs, context);
    if (exact !== null) out.push(exact);
    if (viaDynamoDb && dynamoKms.length > 0) {
      out.push({
        Effect: 'Allow',
        Action: [...dynamoKms],
        Resource: statement.Resource,
        Condition: { StringEquals: { 'kms:ViaService': `dynamodb.${Stack.of(policy).region}.amazonaws.com` } },
      });
    }
  }
  return { ...parsed.data, Statement: out };
}

/** A CfnPolicy document that renders the original and returns it with exact grants. */
class ExactGrantsDocument implements IResolvable {
  public readonly creationStack: string[] = [];

  constructor(private readonly original: unknown, private readonly policy: IConstruct) {}

  public resolve(context: IResolveContext): unknown {
    return rewriteRenderedDocument(renderOriginal(this.original, context), this.policy, context);
  }

  public toString(): string {
    return 'ExactGrantsDocument';
  }
}

/** The original document rendered in `context` (its own post-processing is registered on that context). */
function renderOriginal(original: unknown, context: IResolveContext): unknown {
  return Tokenization.isResolvable(original) ? original.resolve(context) : original;
}

/** Wrap every identity policy under `scope` (call it once, after every stack is built). */
export function applyExactGrants(scope: IConstruct): void {
  for (const construct of scope.node.findAll()) {
    if (!(construct instanceof iam.CfnPolicy) || construct.policyDocument instanceof ExactGrantsDocument) continue;
    construct.policyDocument = new ExactGrantsDocument(construct.policyDocument, construct);
  }
}
