/**
 * Authorization invariant for every method on the VoC REST API.
 *
 * Regression guard for the Checkov CKV_AWS_59 finding on `/feedback-forms`.
 * The item routes sat behind an `anyMethod` proxy that was created without
 * `defaultMethodOptions`, so API Gateway defaulted them to
 * AuthorizationType.NONE: form update, form delete and reads of submitted
 * customer feedback were reachable with no credentials at all, while the
 * collection directly above them was Cognito-protected.
 *
 * The defect was a MISSING ARGUMENT. Nothing threw, no test broke, and a
 * cdk-nag suppression applied to the whole proxy subtree made the entire
 * prefix look assessed. A test asserting "these four routes are protected"
 * would not have caught it either, because the routes did not exist as
 * distinct constructs. So the guard is an invariant over the whole template.
 *
 * OPTIONS is excluded throughout because API Gateway generates unauthenticated
 * CORS preflight methods from `defaultCorsPreflightOptions`, and cdk-nag's own
 * APIG4 rule excludes them for the same reason.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { z } from 'zod';

import { VocApiStack } from './api-stack';
import { ManifestSchema } from '../plugin-loader';

/** The only routes that may be served without credentials.
 *
 *  The three `/feedback-forms/{form_id}/…` routes: the embeddable widget runs on
 *  the customer's own site. `config` and `submit` are fetched by
 *  lambda/api/static/feedback-widget.js; `iframe` is navigated to directly by the
 *  browser in the iframe embed variant.
 *
 *  The two `/voting-sessions/{session_id}/…` routes: a prioritization meeting
 *  scores a proposal as a room, each attendee submitting one ballot from a
 *  personal phone with no account (issue #337). `config` is fetched by the ballot
 *  page so it can say "this session is closed" rather than show a form that
 *  cannot submit; `submit` writes the ballot. The control is the SESSION, not the
 *  obscurity of the link: a ballot is accepted only against a valid unguessable
 *  session token, only while that session is open and unexpired, and only up to
 *  the session's ballot cap — enforced by a conditional atomic increment on the
 *  session record. Closing the session is the revocation.
 *
 *  EXTENDING THIS LIST IS THE REVIEW GATE. It is not a description of the
 *  template; it is the decision. A new entry means somebody chose to publish a
 *  route, and the test below failing until the entry exists is the mechanism. */
const INTENTIONALLY_PUBLIC_ROUTES = [
  'GET /feedback-forms/{form_id}/config',
  'GET /feedback-forms/{form_id}/iframe',
  'GET /voting-sessions/{session_id}/config',
  'POST /feedback-forms/{form_id}/submit',
  'POST /voting-sessions/{session_id}/submit',
];

/** `/mcp` uses a custom Lambda token authorizer because MCP clients cannot run
 *  the Cognito flow. Authenticated, just not by Cognito. */
const CUSTOM_AUTHORIZER_ROUTE_PREFIXES = ['/mcp'];

const PLUGINS_DIR = join(__dirname, '..', '..', 'plugins');

/**
 * Every plugin on disk, enumerated rather than hardcoded — a hardcoded list would
 * make a newly registered plugin invisible to both the all-plugins invariant and
 * the webhook pin below, i.e. exactly the case they exist to catch.
 *
 * `plugins/` also holds Python test files, `__pycache__`, `_shared/` and
 * `_template/` (which does have a manifest.json), so filter the way
 * `loadPlugins` does: a directory with a manifest, not `_`-prefixed.
 */
function discoverPluginIds(): string[] {
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .filter((entry) => existsSync(join(PLUGINS_DIR, entry.name, 'manifest.json')))
    .map((entry) => entry.name)
    .sort();
}

function synthApiTemplate(context: Record<string, unknown> = {}, enabledSources: string[] = []): Template {
  // Skip asset bundling (Docker) and the frontend-freshness guard — template
  // assertions only need structure, and the check would make the suite depend
  // on whether frontend/dist happens to be newer than frontend/src.
  const app = new cdk.App({
    context: { 'aws:cdk:bundling-stacks': [], skipFrontendBuildCheck: true, ...context },
  });
  const env = { account: '111111111111', region: 'us-east-1' };
  const deps = new cdk.Stack(app, 'TestDeps', { env });

  const table = (id: string) => new dynamodb.Table(deps, id, {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  });
  const userPool = new cognito.UserPool(deps, 'UserPool');
  const websiteBucket = new s3.Bucket(deps, 'Website');

  const stack = new VocApiStack(app, 'TestApiStack', {
    env,
    feedbackTable: table('Feedback'),
    aggregatesTable: table('Aggregates'),
    projectsTable: table('Projects'),
    jobsTable: table('Jobs'),
    conversationsTable: table('Conversations'),
    kmsKey: new kms.Key(deps, 'Key'),
    rawDataBucket: new s3.Bucket(deps, 'RawData'),
    avatarsCdnUrl: 'https://cdn.example.invalid/avatars',
    prototypesCdnUrl: 'https://cdn.example.invalid/prototypes',
    cdnSigningSecretArn: `arn:aws:secretsmanager:${env.region}:${env.account}:secret:cdn-signing`,
    cdnSigningKeyPairId: 'KEXAMPLE0000',
    websiteBucket,
    frontendDistribution: new cloudfront.Distribution(deps, 'Dist', {
      defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket) },
    }),
    frontendDomainName: 'app.example.invalid',
    userPool,
    userPoolClient: userPool.addClient('Client'),
    identityPool: new cognito.CfnIdentityPool(deps, 'IdentityPool', { allowUnauthenticatedIdentities: false }),
    authenticatedRole: new iam.Role(deps, 'AuthRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }),
    processingQueueUrl: `https://sqs.${env.region}.amazonaws.com/${env.account}/processing`,
    processingQueueArn: `arn:aws:sqs:${env.region}:${env.account}:processing`,
    secretsArn: `arn:aws:secretsmanager:${env.region}:${env.account}:secret:voc`,
    s3ImportBucket: new s3.Bucket(deps, 'S3Import'),
    researchStateMachine: new sfn.StateMachine(deps, 'Research', {
      definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Pass(deps, 'Noop')),
    }),
    brandName: 'TestBrand',
    enabledSources,
  });

  return Template.fromStack(stack);
}

// Synthesizing is the expensive part of the suite and most tests want the same
// template, so cache the two shapes that get reused.
let cachedDefault: Template | undefined;
let cachedAllPlugins: Template | undefined;

/** No plugins enabled. */
function apiTemplate(): Template {
  cachedDefault ??= synthApiTemplate();
  return cachedDefault;
}

/** Every plugin on disk enabled — the shape a real deployment has. */
function apiTemplateAllPlugins(): Template {
  cachedAllPlugins ??= synthApiTemplate({}, discoverPluginIds());
  return cachedAllPlugins;
}

/** The transitional first-deploy shape. */
let cachedFlagged: Template | undefined;
function apiTemplateFlagged(): Template {
  cachedFlagged ??= synthApiTemplate({ skipFeedbackFormItemRoutes: true });
  return cachedFlagged;
}

// Template values arrive as `unknown`; parse rather than assert (no `as`).
const RefSchema = z.object({ Ref: z.string() });
const GetAttSchema = z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) });
const ResourceIdSchema = z.union([RefSchema, GetAttSchema]);
type ResourceId = z.infer<typeof ResourceIdSchema>;

const ApiResourceSchema = z.object({ PathPart: z.string(), ParentId: ResourceIdSchema });
const MethodSchema = z.object({
  HttpMethod: z.string(),
  ResourceId: ResourceIdSchema,
  AuthorizationType: z.string().optional(),
  AuthorizerId: z.unknown().optional(),
});

interface ApiMethod {
  httpMethod: string;
  path: string;
  authorizationType: string;
  hasAuthorizerId: boolean;
  route: string;
}

/**
 * Reconstructs each method's full path by walking `ParentId` up the
 * AWS::ApiGateway::Resource chain. The root is an `Fn::GetAtt
 * [<api>, RootResourceId]`, which terminates the walk.
 */
function apiMethods(template: Template): ApiMethod[] {
  const parts = new Map<string, { pathPart: string; parentId: ResourceId }>();
  for (const [logicalId, resource] of Object.entries(template.findResources('AWS::ApiGateway::Resource'))) {
    const { PathPart, ParentId } = ApiResourceSchema.parse(resource.Properties);
    parts.set(logicalId, { pathPart: PathPart, parentId: ParentId });
  }

  const pathOf = (id: ResourceId): string => {
    if (!('Ref' in id)) return '';
    const node = parts.get(id.Ref);
    return node ? `${pathOf(node.parentId)}/${node.pathPart}` : '';
  };

  return Object.values(template.findResources('AWS::ApiGateway::Method')).map((method) => {
    const parsed = MethodSchema.parse(method.Properties);
    const path = pathOf(parsed.ResourceId) || '/';
    return {
      httpMethod: parsed.HttpMethod,
      path,
      authorizationType: parsed.AuthorizationType ?? 'NONE',
      hasAuthorizerId: parsed.AuthorizerId !== undefined,
      route: `${parsed.HttpMethod} ${path}`,
    };
  });
}

const nonOptions = (template: Template) => apiMethods(template).filter((m) => m.httpMethod !== 'OPTIONS');
const unauthenticatedRoutes = (template: Template) =>
  nonOptions(template).filter((m) => m.authorizationType === 'NONE').map((m) => m.route).sort();

/** Collapses a caller-side path to the shape the template declares: strips any
 *  query string and normalizes the form-id segment, which appears variously as
 *  `${formId}`, a literal example id, or `{form_id}`.
 *
 *  Deliberately a smoke test, with two known limits: a path built by
 *  concatenation (`'/feedback-forms/' + id + '/submit'`) collapses to
 *  `/feedback-forms` and passes without being checked, and a genuine collection
 *  subresource (say `/feedback-forms/templates`) would be normalized to
 *  `{form_id}` and pass spuriously. It catches the case that actually bit us —
 *  a whole route removed from the stack while a caller still names it — and a
 *  full solution would mean parsing the TypeScript. */
function normalizeFormsPath(raw: string): string {
  const path = raw.split('?')[0].replace(/\/+$/, '');
  return path.replace(/^\/feedback-forms\/[^/]+/, '/feedback-forms/{form_id}');
}

/** Every `/feedback-forms...` path mentioned in a source file. */
function callerFormsPaths(source: string): string[] {
  const matches = source.match(/\/feedback-forms(?:\/[^\s'"`?)]*)*/g) ?? [];
  return [...new Set(matches.map(normalizeFormsPath))].sort();
}

const readRepoFile = (...segments: string[]) => readFileSync(join(__dirname, '..', '..', ...segments), 'utf-8');

describe('VocApiStack authorization invariant', () => {
  it('leaves only the allowlisted widget and ballot routes unauthenticated', () => {
    expect(unauthenticatedRoutes(apiTemplate())).toEqual(INTENTIONALLY_PUBLIC_ROUTES);
  });

  it('discovers the real plugins, excluding scaffolding', () => {
    // Two guards below are only as good as this enumeration, so pin it: it must
    // find plugins, and must not pick up `_template`/`_shared` (which are not
    // deployable) or the Python test files sitting in the same directory.
    const ids = discoverPluginIds();

    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => id.startsWith('_'))).toEqual([]);
    expect(ids.filter((id) => id.endsWith('.py'))).toEqual([]);
    expect(ids).toContain('webscraper');
  });

  it.each([
    'POST /voting-sessions',
    'GET /voting-sessions/{session_id}',
    'POST /voting-sessions/{session_id}/close',
  ])('keeps the facilitator half of a voting session behind Cognito: %s', (route) => {
    // The public half of this feature is two routes and no more. OPENING a
    // session is what authorizes anonymous writes, and CLOSING one is the
    // revocation — publishing either would mean anyone could open a write window
    // on any document, or shut a meeting's vote down from outside the room.
    // Asserted per route rather than left to the invariant above, because that
    // one would also pass if these three vanished from the template entirely.
    const method = apiMethods(apiTemplate()).find((m) => m.route === route);

    expect(method, `${route} is not wired at all`).toBeDefined();
    expect(method?.authorizationType).toBe('COGNITO_USER_POOLS');
    expect(method?.hasAuthorizerId).toBe(true);
  });

  it('leaves only those five unauthenticated with every plugin enabled too', () => {
    // The empty-plugin shape is not what anyone deploys. Plugin webhook
    // receivers are deliberately unauthenticated, so if a plugin ever declares
    // a webhook this fails and forces a considered allowlist entry rather than
    // shipping a new anonymous route silently. No manifest declares one today.
    expect(unauthenticatedRoutes(apiTemplateAllPlugins())).toEqual(INTENTIONALLY_PUBLIC_ROUTES);
  });

  it('pins the fact that makes the allowlist complete: no plugin declares a webhook', () => {
    // Webhook receivers are added with no method options, i.e. deliberately
    // anonymous. Today no manifest declares one, which is why the allowlist
    // above holds no webhook route. Reading the manifests directly makes that
    // assumption fail loudly the day it stops holding — the previous test
    // compares two identical shapes until then, so on its own it cannot.
    //
    // Parsed with the canonical ManifestSchema and `.parse`, deliberately: a
    // local partial schema plus `safeParse` would treat a renamed or moved
    // `infrastructure.webhook.enabled` as "no webhook" and silently disable this
    // guard. Shape drift must throw here, not pass.
    const pluginIds = discoverPluginIds();
    expect(pluginIds.length, 'no plugins discovered — the enumeration is broken').toBeGreaterThan(0);

    const withWebhook = pluginIds.filter((id) => {
      const raw: unknown = JSON.parse(readFileSync(join(PLUGINS_DIR, id, 'manifest.json'), 'utf-8'));
      return ManifestSchema.parse(raw).infrastructure.webhook?.enabled === true;
    });

    expect(
      withWebhook,
      'A plugin now declares a webhook. Webhook methods are unauthenticated by design, '
      + 'so add them to an explicit allowlist in this file rather than widening the assertion.',
    ).toEqual([]);
  });

  it('authenticates every other method with Cognito, not merely "something"', () => {
    // Asserting `!== NONE` would accept a method that regressed to AWS_IAM or
    // picked up a stray authorizer.
    const offenders = nonOptions(apiTemplateAllPlugins())
      .filter((m) => !INTENTIONALLY_PUBLIC_ROUTES.includes(m.route))
      .filter((m) => !CUSTOM_AUTHORIZER_ROUTE_PREFIXES.some((prefix) => m.path.startsWith(prefix)))
      .filter((m) => m.authorizationType !== 'COGNITO_USER_POOLS' || !m.hasAuthorizerId)
      .map((m) => `${m.route} [${m.authorizationType}]`)
      .sort();

    expect(offenders).toEqual([]);
  });

  it('authenticates the custom-authorizer routes with a real authorizer', () => {
    const mcp = nonOptions(apiTemplateAllPlugins())
      .filter((m) => CUSTOM_AUTHORIZER_ROUTE_PREFIXES.some((prefix) => m.path.startsWith(prefix)));

    expect(mcp.length).toBeGreaterThan(0);
    for (const method of mcp) {
      expect(method.authorizationType, method.route).toBe('CUSTOM');
      expect(method.hasAuthorizerId, method.route).toBe(true);
    }
  });

  it.each([
    'PUT /feedback-forms/{form_id}',
    'DELETE /feedback-forms/{form_id}',
    'GET /feedback-forms/{form_id}/submissions',
    'GET /feedback-forms/{form_id}/stats',
  ])('requires an authorizer on %s', (route) => {
    const method = apiMethods(apiTemplate()).find((m) => m.route === route);

    expect(method, `${route} is not wired at all`).toBeDefined();
    expect(method?.authorizationType).toBe('COGNITO_USER_POOLS');
  });
});

describe('stack and callers stay in step', () => {
  it('wires every route the feedback-form handler registers', () => {
    // Independent oracle: the handler source, not the template under test.
    // Without the old {proxy+} catch-all, a route the handler registers but
    // nobody wires returns 403 Missing Authentication Token instead of working.
    const handler = readRepoFile('lambda', 'api', 'feedback_form_handler.py');
    const registered = [...handler.matchAll(/@app\.(get|post|put|delete|route)\(\s*['"]([^'"]+)['"]/g)]
      .map(([, verb, path]) => `${verb.toUpperCase()} ${path.replace(/<(\w+)>/g, '{$1}')}`)
      .sort();

    expect(registered.length).toBeGreaterThan(0);

    const wired = new Set(apiMethods(apiTemplate()).map((m) => m.route));
    expect(registered.filter((route) => !wired.has(route))).toEqual([]);
  });

  it('wires every route the ballots handler registers', () => {
    // Same independent oracle as the feedback-form check above, and it matters
    // more here: two of these routes are reached by a phone with no credentials,
    // so an unwired one answers 403 Missing Authentication Token to a room that
    // has just scanned a QR — with nothing on the page able to explain it.
    const handler = readRepoFile('lambda', 'api', 'ballots_handler.py');
    const registered = [...handler.matchAll(/@app\.(get|post|put|delete|route)\(\s*['"]([^'"]+)['"]/g)]
      .map(([, verb, path]) => `${verb.toUpperCase()} ${path.replace(/<(\w+)>/g, '{$1}')}`)
      .sort();

    expect(registered.length).toBeGreaterThan(0);

    const wired = new Set(apiMethods(apiTemplate()).map((m) => m.route));
    expect(registered.filter((route) => !wired.has(route))).toEqual([]);
  });

  it.each([
    ['the API client', join('frontend', 'src', 'api', 'client.ts')],
    ['the embeddable widget', join('lambda', 'api', 'static', 'feedback-widget.js')],
  ])('wires every /feedback-forms path %s calls', (_label, relativePath) => {
    // Callers fail opaquely now: an unwired path returns 403 rather than the
    // handler's 404, so a caller-side path with no method is a live bug.
    const wiredPaths = new Set(apiMethods(apiTemplate()).map((m) => m.path));
    const referenced = callerFormsPaths(readRepoFile(...relativePath.split('/')));

    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((path) => !wiredPaths.has(path))).toEqual([]);
  });

  it('has no proxy resource left without explicit method options', () => {
    // The original defect in source form: `addProxy` without
    // `defaultMethodOptions` silently publishes everything beneath it.
    //
    // Each call's argument list is delimited by matching its parentheses, not by
    // a fixed window: a fixed slice both false-fails when the option sits just
    // past the cutoff and false-passes on an unrelated occurrence just inside it.
    const source = readRepoFile('lib', 'stacks', 'api-stack.ts');
    const bareProxies = [...source.matchAll(/addProxy\(/g)]
      .map((match) => {
        const open = (match.index ?? 0) + match[0].length - 1;
        let depth = 0;
        for (let i = open; i < source.length; i += 1) {
          if (source[i] === '(') depth += 1;
          else if (source[i] === ')') {
            depth -= 1;
            if (depth === 0) return source.slice(open, i + 1);
          }
        }
        return source.slice(open);
      })
      .filter((call) => !call.includes('defaultMethodOptions'));

    expect(bareProxies).toEqual([]);
  });
});

describe('skipFeedbackFormItemRoutes (transitional upgrade flag)', () => {
  const flagged = apiTemplateFlagged;

  it('omits the item routes so the old {proxy+} can be retired first', () => {
    // {form_id} cannot be created while {proxy+} still exists, and CloudFormation
    // creates before deleting, so the upgrade needs one deploy without these.
    const routes = apiMethods(flagged()).map((m) => m.route);

    expect(routes.filter((route) => route.includes('{form_id}'))).toEqual([]);
    expect(routes).toContain('GET /feedback-forms');
    expect(routes).toContain('POST /feedback-forms');
  });

  it('leaves no FORM route unauthenticated during that transitional deploy', () => {
    // The window is fail-closed for the forms: the public widget routes live
    // under {form_id}, so they are absent too rather than exposed.
    //
    // The public BALLOT routes are unaffected and stay up, which is the intended
    // scope of a flag named for the feedback-form item routes: it exists to retire
    // one old {proxy+}, and taking a prioritization meeting's voting down with it
    // would be an unrelated outage. Asserted as an exact list rather than by
    // filtering the forms out, so a future public route cannot join this window
    // unremarked.
    expect(unauthenticatedRoutes(flagged())).toEqual([
      'GET /voting-sessions/{session_id}/config',
      'POST /voting-sessions/{session_id}/submit',
    ]);
  });

  it('is a no-op when absent — the default template keeps the item routes', () => {
    expect(unauthenticatedRoutes(apiTemplate())).toEqual(INTENTIONALLY_PUBLIC_ROUTES);
    expect(apiMethods(apiTemplate()).map((m) => m.route)).toContain('PUT /feedback-forms/{form_id}');
  });
});


describe('metrics Lambda IAM grants', () => {
  // The /metrics/* and /feedback/entities handlers read a whole date window with
  // a base-table Query on the aggregates table (see _query_metric_window). Every
  // Python test for those endpoints mocks `aggregates_table`, so a narrowed grant
  // would surface only as an AccessDenied 500 in a deployed environment. This
  // pins the action that makes those reads possible.
  const StatementSchema = z.object({
    Action: z.union([z.string(), z.array(z.string())]),
    Resource: z.unknown(),
  });

  // Resource matching is keyed on the logical-ID substring 'Aggregates' appearing
  // in the serialized Ref/GetAtt/ImportValue, since a cross-stack table ARN has no
  // stable literal to compare against. Renaming the table construct away from
  // 'Aggregates' will fail this test rather than silently pass it — the safe
  // direction, but worth knowing before you chase the failure into IAM.
  it('grants dynamodb:Query on the aggregates table itself, not only its indexes', () => {
    const policies = apiTemplate().findResources('AWS::IAM::Policy');
    const metricsPolicy = Object.entries(policies).find(([id]) => id.includes('MetricsLambdaRole'));
    expect(metricsPolicy, 'no IAM policy found for MetricsLambdaRole').toBeDefined();

    const statements = z
      .object({ Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(StatementSchema) }) }) })
      .parse(metricsPolicy?.[1]).Properties.PolicyDocument.Statement;

    const aggregatesQueryStatements = statements.filter((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes('dynamodb:Query') && JSON.stringify(s.Resource).includes('Aggregates');
    });
    expect(aggregatesQueryStatements.length).toBeGreaterThan(0);

    // The bare table ARN must be present, not just the `/index/*` child: a
    // grant covering only indexes would satisfy a laxer check while every
    // windowed read still failed.
    const resources = JSON.stringify(aggregatesQueryStatements.map((s) => s.Resource));
    expect(resources).toContain('Aggregates');
    const hasBareTableArn = aggregatesQueryStatements.some((s) => {
      const list = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
      return list.some((r) => JSON.stringify(r).includes('Aggregates') && !JSON.stringify(r).includes('index/*'));
    });
    expect(hasBareTableArn, 'aggregates Query granted on indexes only').toBe(true);
  });
});


describe('ballots Lambda IAM grants', () => {
  // A ballot is a DECISION record, not customer voice: it is never written to the
  // feedback table and never enqueued for processing, so it gains no sentiment, no
  // persona and no place in any customer metric. That split was made at the write
  // path on purpose, and a comment cannot enforce it — the grants can. The ballots
  // role holds the aggregates table and nothing else, so the unwanted write is
  // impossible rather than merely absent from today's handler.
  const StatementSchema = z.object({
    Action: z.union([z.string(), z.array(z.string())]),
    Resource: z.unknown(),
  });

  function ballotsStatements(): { actions: string[]; resource: string }[] {
    const policies = apiTemplate().findResources('AWS::IAM::Policy');
    const policy = Object.entries(policies).find(([id]) => id.includes('BallotsLambdaRole'));
    expect(policy, 'no IAM policy found for BallotsLambdaRole').toBeDefined();

    return z
      .object({ Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(StatementSchema) }) }) })
      .parse(policy?.[1]).Properties.PolicyDocument.Statement
      .map((s) => ({
        actions: Array.isArray(s.Action) ? s.Action : [s.Action],
        resource: JSON.stringify(s.Resource),
      }));
  }

  it('can write the aggregates table, which holds sessions and ballots', () => {
    const writes = ballotsStatements().filter(
      (s) => s.actions.includes('dynamodb:UpdateItem') && s.resource.includes('Aggregates'),
    );

    expect(writes.length).toBeGreaterThan(0);
  });

  it('holds only the three item actions the handler calls, and no listing or deletion', () => {
    // `grantReadWriteData` would have handed over Query, Scan, DeleteItem,
    // BatchGetItem and BatchWriteItem across the whole aggregates table — which
    // also holds every feedback-form configuration and every signed-in reviewer's
    // ballot — on the ONE function in this stack that two unauthenticated routes
    // reach. The handler reads one item at a time, creates a session and upserts;
    // it never lists, never deletes, never writes in bulk.
    //
    // Asserted as an exact SET rather than as an absence list, so an action nobody
    // considered cannot arrive unremarked: a new grant fails this test and has to
    // be argued for.
    const granted = new Set(
      ballotsStatements()
        .flatMap((s) => s.actions)
        .filter((action) => action.startsWith('dynamodb:')),
    );

    expect([...granted].sort()).toEqual([
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    ]);
  });

  it('cannot reach the feedback table or the processing queue', () => {
    // The resource-name matching is the same logical-ID substring approach the
    // metrics grant test above uses, and carries the same caveat: renaming the
    // Feedback table construct fails this test rather than silently passing it.
    const offenders = ballotsStatements().filter(
      (s) => s.resource.includes('Feedback') || s.actions.some((a) => a.startsWith('sqs:')),
    );

    expect(
      offenders,
      'the ballots Lambda has been granted access to customer feedback or to the '
      + 'processing queue. A ballot is an internal decision record: enriching it '
      + 'would assign a colleague\'s vote a customer persona.',
    ).toEqual([]);
  });
});


describe('the public ballot routes', () => {
  /** The two routes a phone reaches with no credentials, as
   *  `deployOptions.methodOptions` keys them: `{resource path}/{METHOD}`. */
  const PUBLIC_BALLOT_METHOD_KEYS = [
    '/voting-sessions/{session_id}/config/GET',
    '/voting-sessions/{session_id}/submit/POST',
  ];

  const StageSchema = z.object({
    Properties: z.object({
      MethodSettings: z.array(z.object({
        ResourcePath: z.string(),
        HttpMethod: z.string(),
        ThrottlingRateLimit: z.number().optional(),
        ThrottlingBurstLimit: z.number().optional(),
      })).optional(),
    }),
  });

  /** CloudFormation carries a method setting's path in API Gateway's escaped
   *  form, where `~1` stands for `/` — `/voting-sessions/{session_id}/config`
   *  is stored as `/~1voting-sessions~1{session_id}~1config`. Decoded back so the
   *  assertions below read as routes.
   *
   *  This escaping is also why the key has to be pinned rather than trusted: a
   *  mistyped `methodOptions` key is escaped just as happily as a correct one and
   *  produces a setting that matches no method, silently. */
  const decodePath = (escaped: string) => escaped.replace(/^\//, '').replace(/~1/g, '/');

  function methodSettings(): { key: string; rate?: number; burst?: number }[] {
    const stages = Object.values(apiTemplate().findResources('AWS::ApiGateway::Stage'));

    expect(stages.length, 'expected exactly one API stage').toBe(1);

    return (StageSchema.parse(stages[0]).Properties.MethodSettings ?? []).map((s) => ({
      key: `${decodePath(s.ResourcePath)}/${s.HttpMethod}`,
      rate: s.ThrottlingRateLimit,
      burst: s.ThrottlingBurstLimit,
    }));
  }

  it('throttles both of them below the stage default', () => {
    // The stage default is 100/200 for `/*/*`. These two are the only methods on
    // the API that answer an anonymous caller a DynamoDB read, so they get their
    // own tighter pair.
    const settings = new Map(methodSettings().map((s) => [s.key, s]));

    for (const key of PUBLIC_BALLOT_METHOD_KEYS) {
      const setting = settings.get(key);

      expect(setting, `${key} has no method-level throttle`).toBeDefined();
      expect(setting?.rate).toBe(20);
      expect(setting?.burst).toBe(40);
    }
  });

  it('spells those throttle keys the same way the wired routes are spelled', () => {
    // A methodOptions key is a STRING matched against a resource path at deploy
    // time. A typo in it throttles nothing, breaks nothing and reports nothing —
    // the setting is simply never applied — so the two spellings are compared
    // against each other here rather than each being trusted on its own.
    const wired = new Set(apiMethods(apiTemplate()).map((m) => `${m.path}/${m.httpMethod}`));

    expect(PUBLIC_BALLOT_METHOD_KEYS.filter((key) => !wired.has(key))).toEqual([]);
  });

  it('answers CORS preflight on both, which a cross-origin JSON POST requires', () => {
    // `submitBallot` sends Content-Type: application/json to a different host from
    // the SPA, which makes it a non-simple request: the browser sends OPTIONS
    // first and never sends the POST if that fails. The RestApi's
    // `defaultCorsPreflightOptions` generates these, so this asserts the
    // inheritance actually reached the two resources added for this feature —
    // nothing in `addResource` guarantees it, and the failure mode is a room whose
    // ballots never leave the phone.
    const preflight = new Set(
      apiMethods(apiTemplate()).filter((m) => m.httpMethod === 'OPTIONS').map((m) => m.path),
    );

    expect([...PUBLIC_BALLOT_METHOD_KEYS].map((key) => key.replace(/\/[A-Z]+$/, ''))
      .filter((path) => !preflight.has(path))).toEqual([]);
  });

  it('serves the ballots Lambda the site origin, not a wildcard', () => {
    // ALLOWED_ORIGIN is per-FUNCTION, and the three facilitator routes share this
    // function with the two public ones, so a '*' for the benefit of the ballot
    // page would also publish a facilitator's session responses to any origin.
    // It needs no wildcard: the ballot page is a route of this SPA, so a phone
    // opening it sends the same Origin every other page does.
    const functions = apiTemplate().findResources('AWS::Lambda::Function');
    const EnvSchema = z.object({
      Properties: z.object({
        Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
      }),
    });
    const ballots = Object.values(functions).find(
      (fn) => EnvSchema.safeParse(fn).success
        && EnvSchema.parse(fn).Properties.Environment.Variables.POWERTOOLS_SERVICE_NAME === 'voc-ballots-api',
    );

    expect(ballots, 'no Lambda found with POWERTOOLS_SERVICE_NAME voc-ballots-api').toBeDefined();
    expect(EnvSchema.parse(ballots).Properties.Environment.Variables.ALLOWED_ORIGIN)
      .toBe('https://app.example.invalid');
  });
});


describe('the integrations Lambda is handed its plugin secret defaults', () => {
  // PLUGIN_SECRET_DEFAULTS is how the handler learns two things it cannot read
  // at runtime: which sources exist, and what value each key was SEEDED with.
  // The second one is load-bearing. Every key exists from the moment the stack
  // deploys and several defaults are non-empty, so without this the handler's
  // only available test is "does the key hold something", which reports a
  // source as connected before anybody configured it.
  //
  // If this variable goes missing the handler degrades quietly — it reports no
  // sources at all, and no Python test can see the cause, because the cause is
  // in the CDK. Hence the guard lives here.
  const EnvSchema = z.object({
    Properties: z.object({
      Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
    }),
  });

  function integrationsEnv(template: Template = apiTemplate()): Record<string, unknown> {
    const functions = template.findResources('AWS::Lambda::Function');
    const fn = Object.values(functions).find(
      (f) => EnvSchema.safeParse(f).success
        && EnvSchema.parse(f).Properties.Environment.Variables.POWERTOOLS_SERVICE_NAME
          === 'voc-integrations-api',
    );
    expect(fn, 'no Lambda with POWERTOOLS_SERVICE_NAME voc-integrations-api').toBeDefined();
    return EnvSchema.parse(fn).Properties.Environment.Variables;
  }

  it('sets PLUGIN_SECRET_DEFAULTS to a plugin-keyed map of declared defaults', () => {
    const raw = integrationsEnv().PLUGIN_SECRET_DEFAULTS;
    expect(typeof raw).toBe('string');

    const parsed = z.record(z.string(), z.record(z.string(), z.string()))
      .parse(JSON.parse(raw as string));

    // Every real plugin on disk must be present. Read from the manifests rather
    // than listed here, so adding a plugin extends the guard for free.
    const pluginsDir = join(__dirname, '../../plugins');
    const onDisk = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .filter((e) => existsSync(join(pluginsDir, e.name, 'manifest.json')))
      .map((e) => e.name)
      .sort();

    expect(Object.keys(parsed).sort()).toEqual(onDisk);

    // And the values must be the manifests' own declared defaults, since that is
    // the baseline the handler compares stored values against.
    for (const id of onDisk) {
      const manifest = ManifestSchema.parse(
        JSON.parse(readFileSync(join(pluginsDir, id, 'manifest.json'), 'utf-8')),
      );
      expect(parsed[id]).toEqual(manifest.secrets ?? {});
    }
  });

  it('carries a non-empty default, so the comparison it enables is not vacuous', () => {
    // The whole point is distinguishing seeded from entered. If every seeded
    // default were the empty string, a plain truthiness check would have been
    // correct and this variable pointless — so assert the premise holds.
    const parsed: Record<string, Record<string, string>> = JSON.parse(
      integrationsEnv().PLUGIN_SECRET_DEFAULTS as string,
    );
    const nonEmpty = Object.values(parsed).flatMap((keys) => Object.values(keys)).filter(Boolean);
    expect(nonEmpty.length).toBeGreaterThan(0);
  });

  it('leaves the function env well under the 4 KB Lambda limit, worst case', () => {
    // Lambda caps the TOTAL environment at 4096 bytes across all variables, and
    // this one grows with every plugin added. Blowing the budget fails at deploy,
    // not at synth, so measure it here.
    //
    // Measured on the LARGEST env this stack can produce, not the default synth:
    // every plugin on disk enabled, AND a deploymentPrefix set, which is what adds
    // the two INGESTOR_/INGEST_SCHEDULE_ name patterns via prefixOnlyEnv() and
    // lengthens the values. The default no-prefix synth omits those entirely, so a
    // budget measured there would pass while a real prefixed deployment failed.
    for (const [label, variables] of [
      ['default', integrationsEnv()],
      ['all plugins + deploymentPrefix', integrationsEnv(
        synthApiTemplate({ deploymentPrefix: 'x' }, discoverPluginIds()),
      )],
    ] as const) {
      const total = Object.entries(variables)
        .reduce((sum, [k, v]) => sum + Buffer.byteLength(`${k}=${String(v)}`), 0);
      expect(total, `${label} env is ${total} bytes`).toBeLessThan(4096);
    }
  });
});


describe('mcp Lambda IAM grants', () => {
  // The MCP function is the ONE function in this stack reachable with a bearer
  // token instead of a Cognito session, and its role once held
  // grantReadWriteData over the projects table — read-write on every persona,
  // PRD, PR/FAQ and prototype — for the sole purpose of reading token rows and
  // stamping last_used_at. The narrow grant is the enforcement; this test is
  // what makes widening it a deliberate act. Same shape as the ballots grants
  // test above.
  const StatementSchema = z.object({
    Action: z.union([z.string(), z.array(z.string())]),
    Resource: z.unknown(),
    Condition: z.unknown().optional(),
  });
  function mcpStatements(): { actions: string[]; resource: string; condition: unknown }[] {
    const policies = apiTemplate().findResources('AWS::IAM::Policy');
    const policy = Object.entries(policies).find(([id]) => id.includes('McpLambdaRole'));
    expect(policy, 'no IAM policy found for McpLambdaRole').toBeDefined();
    return z
      .object({ Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(StatementSchema) }) }) })
      .parse(policy?.[1]).Properties.PolicyDocument.Statement
      .map((s) => ({
        actions: Array.isArray(s.Action) ? s.Action : [s.Action],
        resource: JSON.stringify(s.Resource),
        condition: s.Condition,
      }));
  }
  it('holds exactly Query and UpdateItem on the projects table', () => {
    // Asserted as an exact SET rather than an absence list, so an action nobody
    // considered cannot arrive unremarked. Query is the token lookup;
    // UpdateItem is last_used_at and nothing else. PutItem, DeleteItem, Scan and
    // the batch APIs are the point of this test: their absence is what makes the
    // bearer-token surface read-only against project artifacts.
    const projectsStatements = mcpStatements().filter((s) => s.resource.includes('Projects'));
    // Guard the filter itself: it string-matches the table's logical id, so a
    // construct rename would make it match NOTHING and turn the exact-set
    // assertion below vacuously green.
    expect(projectsStatements.length, 'no statement names the Projects table').toBeGreaterThan(0);
    const granted = new Set(
      projectsStatements
        .flatMap((s) => s.actions)
        .filter((action) => action.startsWith('dynamodb:')),
    );
    expect([...granted].sort()).toEqual(['dynamodb:Query', 'dynamodb:UpdateItem']);
  });
  it('confines those two actions to the token partition', () => {
    // The adapter reads DynamoDB for exactly one reason — to look up the
    // credential — so the grant says so with a condition rather than trusting the
    // code to stay well behaved. Without it, Query on the table is Query on every
    // PROJECT#... row, i.e. every persona, PRD, PR/FAQ and prototype, from the one
    // function reachable with a bearer token instead of a Cognito session.
    //
    // `ForAllValues:` is load-bearing, not stylistic: LeadingKeys is multi-valued,
    // and plain StringEquals does not constrain a request presenting several keys.
    const partitionValue = readRepoFile('lambda', 'shared', 'mcp_tokens.py')
      .match(/MCP_TOKEN_PK:\s*Final\s*=\s*'([^']+)'/)?.[1];
    expect(partitionValue, 'could not read MCP_TOKEN_PK from mcp_tokens.py').toBeDefined();

    const dynamoStatements = mcpStatements()
      .filter((s) => s.actions.some((a) => a.startsWith('dynamodb:')));
    expect(dynamoStatements.length, 'no DynamoDB statement on the MCP role').toBeGreaterThan(0);
    for (const statement of dynamoStatements) {
      expect(statement.condition, `unconditional DynamoDB grant: ${statement.actions}`).toEqual({
        'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [partitionValue] },
      });
    }
  });
  it('holds no grant at all on the feedback or aggregates tables', () => {
    // The adapter delegates every tool to the function that already owns the
    // route, so it has no business reading the corpus or the aggregates. These
    // grants existed for the in-process tools; leaving them behind would keep the
    // permission alive after the code that needed it was deleted.
    const reachable = mcpStatements()
      .filter((s) => s.actions.some((a) => a.startsWith('dynamodb:')))
      .map((s) => s.resource);
    expect(reachable.filter((r) => r.includes('Feedback'))).toEqual([]);
    expect(reachable.filter((r) => r.includes('Aggregates'))).toEqual([]);
  });
  it('may invoke exactly the domain functions it delegates to', () => {
    // An exact set again: `lambda:InvokeFunction` is how this role now reaches
    // data, so the list of what it may invoke IS its data-access surface. A
    // wildcard here would hand the bearer-token surface every function in the
    // account, including the job runners that spend money.
    const invokeStatements = mcpStatements()
      .filter((s) => s.actions.includes('lambda:InvokeFunction'));
    expect(invokeStatements.length, 'the MCP role cannot invoke anything').toBe(1);

    const resource = invokeStatements[0].resource;
    expect(resource).toContain('MetricsApi');
    expect(resource).toContain('ProjectsApi');
    // No version/alias wildcard: the adapter invokes unqualified names, so `:*`
    // would be a grant nothing uses and a cdk-nag IAM5 suppression to carry.
    expect(resource, 'invoke grant carries a wildcard').not.toContain(':*');
    // And nothing else. Counted on the serialized resource list so a third
    // function added silently fails here rather than at review time.
    const named = (resource.match(/Api[0-9A-F]{8}/g) ?? []).length;
    expect(named, `expected 2 invoke targets, resource was ${resource}`).toBe(2);
  });
  it('can still encrypt against the KMS key, which the UpdateItem write needs', () => {
    // The former grantReadWriteData brought KMS Encrypt along implicitly; the
    // narrow table grant does not, so the role needs it explicitly or the
    // last_used_at write starts failing at runtime — a fault no synth catches.
    const kmsActions = mcpStatements()
      .flatMap((s) => s.actions)
      .filter((a) => a.startsWith('kms:'));
    expect(kmsActions).toContain('kms:Encrypt');
    expect(kmsActions).toContain('kms:Decrypt');
  });
});

describe('mcp delegation stays in step with the stack', () => {
  // The MCP handler registers no @app routes, so the decorator oracle the
  // feedback-form and ballots checks use finds nothing here. Its equivalent is
  // DOMAIN_ROUTES: a table of (domain, method, path) that every tool call is
  // built from. Three things must agree, and nothing at synth time notices when
  // they stop:
  //
  //   1. the route exists in the handler that owns it,
  //   2. the route is wired in API Gateway (the browser needs it too),
  //   3. the owning function is one the MCP role may invoke.
  //
  // A break in any of them is invisible until a client calls that tool and gets
  // a 403, an AccessDenied or a silent empty answer.
  const handlerSource = () => readRepoFile('lambda', 'api', 'mcp_handler.py');

  /** DOMAIN_ROUTES, read from the handler source rather than re-listed here. */
  function declaredRoutes(): { key: string; domain: string; method: string; path: string }[] {
    const table = handlerSource().match(/DOMAIN_ROUTES:[^=]*=\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(table, 'could not find DOMAIN_ROUTES in mcp_handler.py').toBeDefined();
    const rows = [...(table ?? '').matchAll(
      /'([a-z_]+)':\s*\(\s*DOMAIN_([A-Z]+),\s*'([A-Z]+)',\s*'([^']+)'\s*\)/g,
    )];
    expect(rows.length, 'DOMAIN_ROUTES parsed to nothing').toBeGreaterThan(0);
    return rows.map(([, key, domain, method, path]) => ({
      key, domain: domain.toLowerCase(), method, path,
    }));
  }

  /** Which Python handler owns each domain, per _DOMAIN_FUNCTION_ENV. */
  const HANDLER_FOR_DOMAIN: Record<string, string> = {
    metrics: 'metrics_handler.py',
    projects: 'projects_handler.py',
  };

  it('names a domain whose handler file this test knows', () => {
    // Guards the map above: a new domain added to the handler without a line
    // here would make the two tests below skip it silently.
    for (const { key, domain } of declaredRoutes()) {
      expect(HANDLER_FOR_DOMAIN[domain], `${key} names domain '${domain}', unknown to this test`)
        .toBeDefined();
    }
  });

  it('delegates only to routes the owning handler actually registers', () => {
    for (const { key, domain, method, path } of declaredRoutes()) {
      const owner = readRepoFile('lambda', 'api', HANDLER_FOR_DOMAIN[domain]);
      // Powertools spells path parameters <like_this>; DOMAIN_ROUTES uses
      // {like_this} because that is what API Gateway and str.format want.
      const registered = [...owner.matchAll(/@app\.(get|post|put|delete)\(\s*['"]([^'"]+)['"]/g)]
        .map(([, verb, p]) => `${verb.toUpperCase()} ${p.replace(/<(\w+)>/g, '{$1}')}`);
      expect(registered, `${key}: ${method} ${path} is not registered in ${HANDLER_FOR_DOMAIN[domain]}`)
        .toContain(`${method} ${path}`);
    }
  });

  it('delegates only to routes API Gateway wires', () => {
    // A route the handler registers but nobody wires answers 403 Missing
    // Authentication Token — and via delegation that surfaces as a tool error
    // with no obvious cause. Proxy resources count: /metrics/{proxy+} serves the
    // four breakdown paths.
    //
    // 🪤 Path-parameter NAMES are normalized away before comparing, and this test
    // is how that was discovered: the gateway wires `/feedback/{id}` while the
    // handler registers `<feedback_id>`. Production is fine — Powertools matches
    // the concrete path positionally and never consults `pathParameters` — so the
    // shape is the real contract and the names are two independent local choices.
    // Comparing them literally reports a defect that is not there.
    const shape = (path: string) => path.replace(/\{[^}]+\}/g, '{}');

    const wired = apiMethods(apiTemplate());
    const exact = new Set(wired.map((m) => `${m.httpMethod} ${shape(m.path)}`));
    const proxyPrefixes = wired
      .filter((m) => m.path.endsWith('/{proxy+}'))
      .map((m) => m.path.slice(0, -'/{proxy+}'.length));

    for (const { key, method, path } of declaredRoutes()) {
      const servedExactly = exact.has(`${method} ${shape(path)}`);
      const servedByProxy = proxyPrefixes.some((prefix) => path.startsWith(`${prefix}/`));
      expect(servedExactly || servedByProxy, `${key}: ${method} ${path} is wired nowhere`).toBe(true);
    }
  });

  it('hands down a function name for every domain it delegates to', () => {
    // The env keys the handler reads must be the env keys the stack sets.
    // Rebuilding a function name in Python from account/region would, under a
    // deploymentPrefix, name a function that does not exist.
    const envKeys = [...handlerSource().matchAll(/DOMAIN_(?:METRICS|PROJECTS):\s*'([A-Z_]+)'/g)]
      .map(([, key]) => key);
    expect(envKeys.length, 'no _DOMAIN_FUNCTION_ENV entries parsed').toBeGreaterThan(0);

    const mcpFn = Object.values(apiTemplate().findResources('AWS::Lambda::Function'))
      .map((fn) => z.object({
        Properties: z.object({
          Handler: z.string().optional(),
          Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }).optional(),
        }),
      }).parse(fn).Properties)
      .find((p) => p.Handler === 'mcp_handler.lambda_handler');
    expect(mcpFn, 'no Lambda with the mcp_handler entry point').toBeDefined();

    const variables = mcpFn?.Environment?.Variables ?? {};
    for (const key of envKeys) {
      expect(variables, `mcp_handler reads ${key}, which the stack does not set`).toHaveProperty(key);
    }
    // The tables the tools no longer read must not be advertised either.
    expect(variables).not.toHaveProperty('FEEDBACK_TABLE');
    expect(variables).not.toHaveProperty('AGGREGATES_TABLE');
  });
});

describe('lambda role policies stay under the IAM size limit', () => {
  // The repo's whole domain-split Lambda architecture exists because of this
  // limit, yet nothing measured it. The failure mode is a deploy-time rejection
  // with no synth warning — exactly the class of fault this suite converts into
  // a test.
  //
  // ⚠️ THE NUMBERS, because the repo's docs round them to "20 KB" and that is
  // above the real ceiling, so a guard set there could never fire:
  //   • an INLINE policy on a role (what AWS::IAM::Policy creates, and what
  //     every grant* call in this stack produces) — 10,240 characters;
  //   • a MANAGED policy (AWS::IAM::ManagedPolicy) — 6,144 characters.
  // IAM does not count whitespace toward either, so the measurement below
  // strips it, which is also what makes the count comparable to the quota
  // rather than to `JSON.stringify`'s output.
  //   https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html
  //
  // All three shapes are measured — AWS::IAM::Policy, AWS::IAM::ManagedPolicy,
  // and inline `Policies` on AWS::IAM::Role — because measuring only the first
  // would let a role exceed its quota with this test green.
  //
  // Still an APPROXIMATION, stated so nobody reads it as exact: the template
  // carries `{"Fn::GetAtt": …}` and `{"Fn::ImportValue": …}` where the deployed
  // policy carries resolved ARNs, so per-statement counts differ in both
  // directions. It tracks the thing that actually grows — statement count — so
  // it works as a trend alarm even though it is not byte-for-byte the number IAM
  // checks. Largest policy today is ~2 KB against a 10,240 ceiling.
  const INLINE_LIMIT = 10_240;
  const MANAGED_LIMIT = 6_144;
  // Fire at 70% so there is room to land a feature and then split a domain,
  // rather than discovering the ceiling in the middle of a deploy.
  const WARN_FRACTION = 0.7;

  const DocumentSchema = z.object({ Properties: z.object({ PolicyDocument: z.unknown() }) });
  const RoleSchema = z.object({
    Properties: z.object({
      Policies: z.array(z.object({ PolicyName: z.unknown(), PolicyDocument: z.unknown() })).optional(),
    }),
  });

  // `JSON.stringify` emits no structural whitespace, so a `replace(/\s/g,'')`
  // here could only ever strip whitespace INSIDE string values — Sids, condition
  // values, ARNs with spaces — which IAM does count. Measuring the serialized
  // length directly is both simpler and closer to the quota.
  const size = (document: unknown) => JSON.stringify(document).length;

  function policies(): { id: string; kind: string; chars: number; limit: number }[] {
    const template = apiTemplate();
    const measured: { id: string; kind: string; chars: number; limit: number }[] = [];

    for (const [id, resource] of Object.entries(template.findResources('AWS::IAM::Policy'))) {
      measured.push({
        id, kind: 'inline', limit: INLINE_LIMIT,
        chars: size(DocumentSchema.parse(resource).Properties.PolicyDocument),
      });
    }
    for (const [id, resource] of Object.entries(template.findResources('AWS::IAM::ManagedPolicy'))) {
      measured.push({
        id, kind: 'managed', limit: MANAGED_LIMIT,
        chars: size(DocumentSchema.parse(resource).Properties.PolicyDocument),
      });
    }
    // Inline policies declared ON the role rather than as a separate resource.
    // None today, which is exactly why they need measuring: the first one added
    // would otherwise arrive unmeasured.
    for (const [id, resource] of Object.entries(template.findResources('AWS::IAM::Role'))) {
      for (const policy of RoleSchema.parse(resource).Properties.Policies ?? []) {
        measured.push({
          id: `${id}/${JSON.stringify(policy.PolicyName)}`, kind: 'inline-on-role',
          limit: INLINE_LIMIT, chars: size(policy.PolicyDocument),
        });
      }
    }
    return measured;
  }

  // Measured once: each call walks the whole synthesized template.
  let measured: ReturnType<typeof policies>;
  beforeAll(() => { measured = policies(); });

  it('measures every policy shape the stack can produce', () => {
    // Vacuity guard, and it names the shapes so a future one is a deliberate add.
    expect(measured.length).toBeGreaterThan(0);
    expect(new Set(measured.map((p) => p.kind)).has('inline'),
      'no AWS::IAM::Policy measured — has the filter drifted?').toBe(true);
  });

  it('keeps every policy under its IAM quota', () => {
    expect(measured.filter((p) => p.chars >= p.limit),
      'policies at or over their IAM character quota').toEqual([]);
  });

  it('keeps every policy under 70% of its quota', () => {
    // If this fails, the answer is a new domain Lambda, not a bigger threshold.
    // Raising the fraction here is how the ceiling gets hit for real.
    expect(measured.filter((p) => p.chars >= p.limit * WARN_FRACTION),
      'policies past 70% of their IAM quota — split the domain instead').toEqual([]);
  });
});

describe('the delegation timeout budget', () => {
  // The adapter gives up on a domain call before its OWN Lambda timeout, so a
  // slow route produces a -32603 rather than a Lambda timeout with no JSON-RPC
  // envelope at all. That ordering is the invariant worth pinning, and nothing
  // else notices if it inverts.
  const readTimeout = () => {
    const source = readRepoFile('lambda', 'shared', 'mcp_delegate.py');
    const seconds = source.match(/_DELEGATE_READ_TIMEOUT_SECONDS:\s*Final\s*=\s*(\d+)/)?.[1];
    expect(seconds, 'could not read _DELEGATE_READ_TIMEOUT_SECONDS').toBeDefined();
    return Number(seconds);
  };

  const FunctionSchema = z.object({
    Properties: z.object({ Handler: z.string().optional(), Timeout: z.number().optional() }),
  });
  const functionByHandler = (handler: string) =>
    Object.values(apiTemplate().findResources('AWS::Lambda::Function'))
      .map((fn) => FunctionSchema.parse(fn).Properties)
      .find((p) => p.Handler === handler);

  it('gives the adapter time to answer after it stops waiting', () => {
    const adapter = functionByHandler('mcp_handler.lambda_handler');
    expect(adapter, 'no Lambda with the mcp_handler entry point').toBeDefined();
    expect(readTimeout()).toBeLessThan(adapter?.Timeout ?? 0);
  });

  it('does not require the callees to finish sooner than the adapter waits', () => {
    // Deliberately NOT asserted the other way round, which a review suggested.
    // The metrics and projects functions serve the browser too, where 30 s is the
    // right budget, and API Gateway caps the OUTER request at 29 s regardless —
    // so a delegated call that ran longer than the adapter's patience was never
    // going to be delivered. The callee may still be running when the adapter
    // gives up; that is inherent to a timeout, and it is why retries are off.
    // This test records the relationship so the asymmetry reads as chosen.
    for (const handler of ['metrics_handler.lambda_handler', 'projects_handler.lambda_handler']) {
      const fn = functionByHandler(handler);
      expect(fn, `${handler} is not in the template`).toBeDefined();
      expect(fn?.Timeout, `${handler} timeout`).toBeGreaterThanOrEqual(readTimeout());
    }
  });
});

describe('the search fan-out fits the metrics timeout', () => {
  // `/feedback/search` walks ONE DynamoDB query per day partition, because
  // gsi1-by-date is partitioned BY DAY (`gsi1pk = DATE#YYYY-MM-DD`) and no index
  // supports a bounded multi-day query with a usable projection. Removing the old
  // undocumented `min(days, 30)` cap — which made most of the corpus unreachable
  // by text search — means the loop can now run for the FULL validated window.
  //
  // So the window ceiling and the Lambda timeout are coupled. This pins the
  // arithmetic: raising the window maximum, or lowering the metrics timeout, fails
  // here instead of producing 502s on a year-long search. The measured cost is
  // ~10-15 ms per day partition (p50, sparse days), so the upper bound is used.
  // Note this bounds a PROJECTION, not live latency — it guards config drift.
  //
  // 🔑 The Lambda timeout is deliberately NOT asserted against the API Gateway
  // ceiling. `MetricsApi` serves the browser across every `/metrics/*` and
  // `/feedback/*` route, where 30 s is the right budget, and the sibling suite
  // above records the same asymmetry for the delegation path. A Lambda outliving
  // the 29 s integration wastes tail compute on a response nobody receives; one
  // that dies sooner turns a slow-but-valid answer into a 502, which is worse. Any
  // assertion tying the two would have to be widened to fit the config it claims
  // to constrain, and could then never fail for the reason it advertises.
  const MEASURED_MS_PER_DAY = 15;
  const SAFETY_FACTOR = 2;
  // API Gateway hard-caps a REST integration at 29 s regardless of the Lambda's
  // own timeout, so a budget above this is unreachable however it is configured.
  const API_GATEWAY_INTEGRATION_CEILING_SECONDS = 29;

  const maxWindowDays = () => {
    // Aimed at the NAMED constant rather than at a function's parameter default,
    // which a rename or a moved default would silently stop matching. The
    // `toBeDefined` below turns any such drift into a loud failure rather than a
    // vacuous pass.
    const source = readRepoFile('lambda', 'shared', 'api.py');
    const maxVal = source.match(/^MAX_FEEDBACK_WINDOW_DAYS\s*=\s*(\d+)/m)?.[1];
    expect(maxVal, 'could not read MAX_FEEDBACK_WINDOW_DAYS from shared/api.py').toBeDefined();
    return Number(maxVal);
  };

  const metricsTimeout = () => {
    const fn = Object.values(apiTemplate().findResources('AWS::Lambda::Function'))
      .map((f) => z.object({
        Properties: z.object({ Handler: z.string().optional(), Timeout: z.number().optional() }),
      }).parse(f).Properties)
      .find((p) => p.Handler === 'metrics_handler.lambda_handler');
    expect(fn, 'no Lambda with the metrics_handler entry point').toBeDefined();
    return fn?.Timeout ?? 0;
  };

  it('leaves the metrics function time for a full-window search', () => {
    const days = maxWindowDays();
    const worstCaseSeconds = (days * MEASURED_MS_PER_DAY) / 1000;
    const budget =
      `a ${days}-day search projects to ~${worstCaseSeconds.toFixed(1)}s at ` +
      `${MEASURED_MS_PER_DAY}ms/day`;

    // One guard, two bounds on the same projected number: it must fit the Lambda's
    // own budget with margin, and it must fit the ceiling the caller is bounded by.
    expect(metricsTimeout(), `${budget}; the metrics timeout must cover it with margin`)
      .toBeGreaterThanOrEqual(worstCaseSeconds * SAFETY_FACTOR);

    // And the caller's own ceiling, which no Lambda timeout can rescue a request
    // from once API Gateway has abandoned it.
    expect(worstCaseSeconds, `${budget}; API Gateway stops waiting at ${API_GATEWAY_INTEGRATION_CEILING_SECONDS}s`)
      .toBeLessThan(API_GATEWAY_INTEGRATION_CEILING_SECONDS);
  });
});

describe('mcp endpoint throttling', () => {
  // The former McpUsagePlan never bound: a usage plan's throttle applies per
  // API KEY and no MCP client sends one (SEC-10's fourth sub-claim, open since
  // #260). The working mechanism is stage method settings, keyed by path —
  // and a mistyped key throttles nothing silently, hence the lockstep test.
  const MCP_METHOD_KEYS = [
    '/mcp/POST',
    // Concrete verbs, not a wildcard: a live deploy established that API
    // Gateway rejects both '/{path}/*' and 'ANY' as method-setting keys
    // (per-path wildcards do not exist; '*/*' is stage-wide only). POST is
    // JSON-RPC on subpaths, GET is the autoseed side-door — the two verbs
    // the proxy serves that reach DynamoDB.
    '/mcp/{proxy+}/POST',
    '/mcp/{proxy+}/GET',
  ];
  const StageSchema = z.object({
    Properties: z.object({
      MethodSettings: z.array(z.object({
        ResourcePath: z.string(),
        HttpMethod: z.string(),
        ThrottlingRateLimit: z.number().optional(),
        ThrottlingBurstLimit: z.number().optional(),
      })).optional(),
    }),
  });
  const decodePath = (escaped: string) => escaped.replace(/^\//, '').replace(/~1/g, '/');
  function methodSettings(): { key: string; rate?: number; burst?: number }[] {
    const stages = Object.values(apiTemplate().findResources('AWS::ApiGateway::Stage'));
    expect(stages.length, 'expected exactly one API stage').toBe(1);
    return (StageSchema.parse(stages[0]).Properties.MethodSettings ?? []).map((s) => ({
      key: `${decodePath(s.ResourcePath)}/${s.HttpMethod}`,
      rate: s.ThrottlingRateLimit,
      burst: s.ThrottlingBurstLimit,
    }));
  }
  it('throttles the MCP methods below the stage default', () => {
    const settings = new Map(methodSettings().map((s) => [s.key, s]));
    for (const key of MCP_METHOD_KEYS) {
      const setting = settings.get(key);
      expect(setting, `${key} has no method-level throttle`).toBeDefined();
      expect(setting?.rate).toBe(20);
      expect(setting?.burst).toBe(40);
    }
  });
  it('spells those keys the way the wired routes are spelled', () => {
    // Every key must name a wired resource path, and its concrete verb must
    // be servable there: `/mcp/POST` is an exact method, and the proxy keys'
    // verbs are covered by the proxy's ANY method. A mistyped key is escaped
    // happily and throttles nothing, silently — this is the guard.
    const wired = apiMethods(apiTemplate());
    const wiredKeys = new Set(wired.map((m) => `${m.path}/${m.httpMethod}`));
    for (const key of MCP_METHOD_KEYS) {
      const path = key.slice(0, key.lastIndexOf('/'));
      const verb = key.slice(key.lastIndexOf('/') + 1);
      const servable = wiredKeys.has(`${path}/${verb}`) || wiredKeys.has(`${path}/ANY`);
      expect(servable, `${key} names no wired method (nor an ANY on its path)`).toBe(true);
    }
  });
  it('has no usage plan anywhere in the stack', () => {
    // A usage plan that "throttles" a keyless endpoint is worse than absent:
    // it reads as protection and provides none. If one ever returns, it has to
    // be argued past this test.
    expect(Object.keys(apiTemplate().findResources('AWS::ApiGateway::UsagePlan'))).toEqual([]);
  });
});


describe('mcp transport headers reach a browser', () => {
  // `mcp_handler.py` reads and VALIDATES three transport headers, and a browser's
  // preflight on this API is answered by API Gateway's generated OPTIONS mock —
  // not by the handler. So the handler allowing them in its own CORS response is
  // not enough: omitted from the gateway's list, a browser-based client that sends
  // `MCP-Protocol-Version` is blocked by its own preflight before the Lambda ever
  // sees the request, and the server ends up enforcing a rule against a header no
  // browser can deliver.
  //
  // Read out of the PYTHON source rather than re-listed here, which is this repo's
  // convention for a contract two languages have to agree on (see the
  // MCP_TOKEN_PK test above): a header added to the handler and not to the gateway
  // fails here instead of at a browser.
  const pythonTransportHeaders = (): string[] => {
    const source = readRepoFile('lambda', 'api', 'mcp_handler.py');
    const block = source.match(/TRANSPORT_HEADERS:\s*tuple\[str, \.\.\.\]\s*=\s*\(([^)]*)\)/)?.[1];
    expect(block, 'could not read TRANSPORT_HEADERS from mcp_handler.py').toBeDefined();
    // The tuple holds the NAMED constants, so resolve each to its literal.
    const names = [...(block ?? '').matchAll(/([A-Z_]+),/g)].map((m) => m[1]);
    expect(names.length, 'TRANSPORT_HEADERS looks empty').toBeGreaterThan(0);
    return names.map((name) => {
      const value = source.match(new RegExp(`^${name} = '([^']+)'`, 'm'))?.[1];
      expect(value, `could not resolve ${name} in mcp_handler.py`).toBeDefined();
      return value as string;
    });
  };

  /** The allow-list the generated OPTIONS mock actually publishes. */
  const preflightAllowHeaders = (): string[] => {
    const methods = Object.values(apiTemplate().findResources('AWS::ApiGateway::Method'));
    const MethodSchema = z.object({
      Properties: z.object({
        HttpMethod: z.string(),
        Integration: z.object({
          IntegrationResponses: z.array(z.object({
            ResponseParameters: z.record(z.string(), z.string()).optional(),
          })).optional(),
        }).optional(),
      }),
    });
    for (const method of methods) {
      const props = MethodSchema.parse(method).Properties;
      if (props.HttpMethod !== 'OPTIONS') continue;
      for (const response of props.Integration?.IntegrationResponses ?? []) {
        const raw = response.ResponseParameters?.[
          'method.response.header.Access-Control-Allow-Headers'
        ];
        if (raw) return raw.replace(/^'|'$/g, '').split(',');
      }
    }
    throw new Error('no generated OPTIONS method published an Allow-Headers list');
  };

  it('allows every header the handler validates through the preflight', () => {
    const allowed = new Set(preflightAllowHeaders().map((h) => h.trim().toLowerCase()));
    const declared = pythonTransportHeaders();

    // Positive control: a regex that silently matched nothing would make the
    // subset assertion below vacuously true.
    expect(declared.length).toBeGreaterThanOrEqual(3);
    for (const header of declared) {
      // Case-insensitively, because CORS header matching is — the handler reads
      // the lowercase form API Gateway delivers, the gateway publishes the wire
      // spelling, and both must name the same header.
      expect(allowed, `${header} is validated by the handler but blocked by the preflight`)
        .toContain(header.toLowerCase());
    }
  });

  it('allows them on the gateway error responses too', () => {
    // A 4XX/5XX from the gateway itself carries its own CORS headers, and a
    // browser that cannot read the error sees a network failure instead of the
    // 401 or 400 the server actually sent.
    const responses = Object.values(
      apiTemplate().findResources('AWS::ApiGateway::GatewayResponse'),
    );
    const ResponseSchema = z.object({
      Properties: z.object({
        ResponseType: z.string(),
        ResponseParameters: z.record(z.string(), z.string()).optional(),
      }),
    });
    const declared = pythonTransportHeaders().map((h) => h.toLowerCase());
    const parsed = responses.map((r) => ResponseSchema.parse(r).Properties);
    expect(parsed.length, 'no gateway responses in the template').toBeGreaterThan(0);

    for (const props of parsed) {
      const raw = props.ResponseParameters?.[
        'gatewayresponse.header.Access-Control-Allow-Headers'
      ];
      if (!raw) continue;
      const allowed = new Set(
        raw.replace(/^'|'$/g, '').split(',').map((h) => h.trim().toLowerCase()),
      );
      for (const header of declared) {
        expect(allowed, `${header} missing from the ${props.ResponseType} response`)
          .toContain(header);
      }
    }
  });
});

describe('unauthorized gateway response', () => {
  // The ONLY place a REST API can emit a true WWW-Authenticate on a 401:
  // Lambda-proxy responses have the header unconditionally remapped to
  // x-amzn-remapped-www-authenticate (verified live). Removing this response
  // or either header would be silent — the handler-side header keeps flowing,
  // remapped — so the delivery path for the RFC 6750 challenge is pinned here.
  it('carries the Bearer challenge and exposes it to browsers', () => {
    const responses = Object.values(
      apiTemplate().findResources('AWS::ApiGateway::GatewayResponse'),
    );
    const ResponseSchema = z.object({
      Properties: z.object({
        ResponseType: z.string(),
        ResponseParameters: z.record(z.string(), z.string()).optional(),
      }),
    });
    const unauthorized = responses
      .map((r) => ResponseSchema.parse(r).Properties)
      .find((p) => p.ResponseType === 'UNAUTHORIZED');
    expect(unauthorized, 'no UNAUTHORIZED gateway response in the template').toBeDefined();
    const params = unauthorized?.ResponseParameters ?? {};
    expect(params['gatewayresponse.header.WWW-Authenticate']).toBe('\'Bearer error="invalid_token"\'');
    expect(params['gatewayresponse.header.Access-Control-Expose-Headers']).toBe("'WWW-Authenticate'");
  });
});
