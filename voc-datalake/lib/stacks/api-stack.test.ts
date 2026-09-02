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

import { describe, it, expect } from 'vitest';
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
  });
  function mcpStatements(): { actions: string[]; resource: string }[] {
    const policies = apiTemplate().findResources('AWS::IAM::Policy');
    const policy = Object.entries(policies).find(([id]) => id.includes('McpLambdaRole'));
    expect(policy, 'no IAM policy found for McpLambdaRole').toBeDefined();
    return z
      .object({ Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(StatementSchema) }) }) })
      .parse(policy?.[1]).Properties.PolicyDocument.Statement
      .map((s) => ({
        actions: Array.isArray(s.Action) ? s.Action : [s.Action],
        resource: JSON.stringify(s.Resource),
      }));
  }
  it('holds exactly Query and UpdateItem on the projects table', () => {
    // Asserted as an exact SET rather than an absence list, so an action nobody
    // considered cannot arrive unremarked. Query is the token lookup plus the
    // get_project/list_personas tools; UpdateItem is last_used_at and nothing
    // else. PutItem, DeleteItem, Scan and the batch APIs are the point of this
    // test: their absence is what makes the bearer-token surface read-only
    // against project artifacts.
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


describe('ChatStream canonical project delegation', () => {
  const FunctionSchema = z.object({
    Properties: z.object({
      Environment: z.object({ Variables: z.record(z.unknown()) }),
      Role: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) }),
    }),
  });
  const StatementSchema = z.object({
    Action: z.union([z.string(), z.array(z.string())]),
    Resource: z.unknown(),
  });
  const PolicySchema = z.object({
    Properties: z.object({
      Roles: z.array(z.object({ Ref: z.string() })),
      PolicyDocument: z.object({ Statement: z.array(StatementSchema) }),
    }),
  });

  it('injects the Projects function and may invoke only that canonical reader', () => {
    const functions = Object.entries(
      apiTemplate().findResources('AWS::Lambda::Function'),
    );
    const parsedFunctions = functions.flatMap(([logicalId, resource]) => {
      const parsed = FunctionSchema.safeParse(resource);
      return parsed.success ? [{ logicalId, properties: parsed.data.Properties }] : [];
    });
    const chat = parsedFunctions.find(
      ({ properties }) => properties.Environment.Variables.BEDROCK_MODEL_ID
        === 'global.anthropic.claude-sonnet-5',
    );
    const projects = parsedFunctions.find(
      ({ properties }) => properties.Environment.Variables.POWERTOOLS_SERVICE_NAME
        === 'voc-projects-api',
    );
    expect(chat, 'ChatStream Lambda not found').toBeDefined();
    expect(projects, 'Projects API Lambda not found').toBeDefined();
    if (!chat || !projects) return;

    expect(chat.properties.Environment.Variables.PROJECTS_FUNCTION).toStrictEqual({
      Ref: projects.logicalId,
    });

    const chatRoleId = chat.properties.Role['Fn::GetAtt'][0];
    const statements = Object.values(
      apiTemplate().findResources('AWS::IAM::Policy'),
    ).flatMap((resource) => {
      const parsed = PolicySchema.safeParse(resource);
      if (!parsed.success) return [];
      const attached = parsed.data.Properties.Roles.some(
        (role) => role.Ref === chatRoleId,
      );
      return attached ? parsed.data.Properties.PolicyDocument.Statement : [];
    });
    const invokeStatements = statements.filter((statement) => {
      const actions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      return actions.includes('lambda:InvokeFunction');
    });

    expect(invokeStatements).toHaveLength(1);
    expect(invokeStatements[0].Resource).toStrictEqual([
      { 'Fn::GetAtt': [projects.logicalId, 'Arn'] },
      {
        'Fn::Join': [
          '',
          [
            { 'Fn::GetAtt': [projects.logicalId, 'Arn'] },
            ':*',
          ],
        ],
      },
    ]);
  });
});
