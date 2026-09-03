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

/** `-c environment=dev`, the shape that loosens `allowedOrigin` to '*'. Cached
 *  like the other three, so calling any of these repeatedly inside a case costs
 *  a map lookup rather than another synth. */
let cachedDev: Template | undefined;
function apiTemplateDev(): Template {
  cachedDev ??= synthApiTemplate({ environment: 'dev' });
  return cachedDev;
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

/** Every method except CORS preflight.
 *
 *  OPTIONS is excluded from the authorization invariant AND from "every
 *  unauthenticated route gets an explicit throttle", which review asked about
 *  directly. The answer is that preflight is in scope for the CONCERN and already
 *  satisfied, not exempt from it — and the two facts it rests on are ASSERTED by
 *  `CORS preflight is unauthenticated and reaches no compute, which is why it is
 *  excluded above`, not stated here as figures that would rot.
 *
 *  `NONE` is not a choice: a browser sends no credentials on a preflight, so
 *  requiring an authorizer would break CORS for every caller. `MOCK` is what makes
 *  the throttle question different in kind from the three routes this change is
 *  about — a preflight reaches no Lambda, no DynamoDB and no Bedrock, so there is
 *  no per-call cost to bound, only gateway requests, and the stage-wide default
 *  (an explicit pair in its own right) already bounds those.
 *
 *  The trigger is therefore MOCK, and the assertion below is what fires on it: a
 *  Lambda-backed OPTIONS would make a preflight cost real compute and would need
 *  its own pair. Per-method pairs for every preflight buy nothing while they are
 *  all MOCK, and would have to be maintained against every route added. */
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
 *  This escaping is also why every method-setting key has to be pinned rather
 *  than trusted: a mistyped `methodOptions` key is escaped just as happily as a
 *  correct one and produces a setting that matches no method, silently. */
const decodePath = (escaped: string) => escaped.replace(/^\//, '').replace(/~1/g, '/');

/** Every stage method setting, keyed `{resource path}/{METHOD}`.
 *
 *  Takes the template as a PARAMETER rather than closing over `apiTemplate()`,
 *  which is what lets the orphan-key invariant run over both the default and the
 *  `skipFeedbackFormItemRoutes` shapes. One copy at module scope: three describe
 *  blocks below need it, and three near-identical private copies is duplication
 *  REVIEW has to catch here — no linter covers `lib/`. The only ESLint configs in
 *  the tree are frontend/ and lambda/stream/, and the root `lint` script is
 *  `lint:frontend && lint:stream && lint:python`, so nothing in this directory is
 *  linted at all (the frontend config additionally ignores `**\/*.test.ts`). */
function methodSettings(template: Template): { key: string; rate?: number; burst?: number }[] {
  const stages = Object.values(template.findResources('AWS::ApiGateway::Stage'));

  expect(stages.length, 'expected exactly one API stage').toBe(1);

  return (StageSchema.parse(stages[0]).Properties.MethodSettings ?? []).map((s) => ({
    key: `${decodePath(s.ResourcePath)}/${s.HttpMethod}`,
    rate: s.ThrottlingRateLimit,
    burst: s.ThrottlingBurstLimit,
  }));
}

describe('VocApiStack authorization invariant', () => {
  it('leaves only the allowlisted widget and ballot routes unauthenticated', () => {
    // The COUNT as well as the contents, and here rather than in one of the
    // per-feature describes below: five is the number a change to either public
    // set has to argue past, so it belongs with the invariant itself instead of
    // being restated once per feature that touches those routes. A throttle, a
    // CORS value or a rewired resource tree is not an authorization change — this
    // is the single guard that says so for all of them.
    expect(INTENTIONALLY_PUBLIC_ROUTES).toHaveLength(5);
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
    ['the embed URL builder', join('frontend', 'src', 'api', 'feedbackFormUrls.ts')],
  ])('wires every /feedback-forms path %s calls', (_label, relativePath) => {
    // Callers fail opaquely now: an unwired path returns 403 rather than the
    // handler's 404, so a caller-side path with no method is a live bug.
    //
    // The third entry is the producer of the path the corrected docs now name as
    // THE embed URL (#374): `feedbackFormUrls.ts` builds `/{form_id}/iframe`, and
    // the UI hands it out as a link, a copyable string and an <iframe> snippet —
    // yet `client.ts` mentions `iframe` nowhere, so before this the one route the
    // docs advertise had no parity check from the code that constructs it.
    //
    // Asserted as "wired", matching its two siblings rather than the
    // unauthenticated oracle below: this module runs in the authenticated
    // dashboard, and what it produces for a stranger's browser is checked at the
    // docs snippet.
    //
    // Known narrowing, inherited from `callerFormsPaths`: the returned URL is a
    // template literal, so `${base}/feedback-forms/${encodeURIComponent(formId)}`
    // collapses at the `)` and the `/iframe` segment is recovered from the
    // module's docblock, which names the literal path twice. Losing those lines
    // would quietly reduce this entry to checking `/feedback-forms/{form_id}`.
    const wiredPaths = new Set(apiMethods(apiTemplate()).map((m) => m.path));
    const referenced = callerFormsPaths(readRepoFile(...relativePath.split('/')));

    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((path) => !wiredPaths.has(path))).toEqual([]);
  });

  // The companion to the check above, and the reason it is a separate `it` rather
  // than a third column on that `it.each`: this PR's standing verification claim is
  // that `api-stack.test.ts` gains tests without editing an existing assertion, so
  // that the deletion's correctness rests on untouched oracles. Adding a column
  // would have edited the tuples and the callback signature. Additions only.
  //
  // What it closes: `callerFormsPaths` extracts with a regex, so anything defeating
  // the regex shrinks the extracted set and "every path resolves" then holds
  // VACUOUSLY over what survived — green for the wrong reason, which `length > 0`
  // cannot distinguish from a full extraction. Not hypothetical for the third
  // entry: its URL is a template literal, so
  // `${base}/feedback-forms/${encodeURIComponent(formId)}` collapses at the `)` and
  // `/iframe` is recovered only from that module's DOCBLOCK, which names the literal
  // path. Deleting a comment line there reduced this to checking
  // `/feedback-forms/{form_id}` while staying green.
  it.each([
    ['the API client', join('frontend', 'src', 'api', 'client.ts'),
      '/feedback-forms/{form_id}/submissions'],
    ['the embeddable widget', join('lambda', 'api', 'static', 'feedback-widget.js'),
      '/feedback-forms/{form_id}/config'],
    ['the embed URL builder', join('frontend', 'src', 'api', 'feedbackFormUrls.ts'),
      '/feedback-forms/{form_id}/iframe'],
  ])('still extracts the path %s is checked for', (_label, relativePath, requiredPath) => {
    const referenced = callerFormsPaths(readRepoFile(...relativePath.split('/')));

    expect(
      referenced,
      `extraction lost ${requiredPath} — this caller's paths are no longer being checked, `
      + 'even though the wiring assertion still passes over whatever survived',
    ).toContain(requiredPath);
  });

  it.each([
    ['the integrator guide', join('..', 'docs', 'feedback-forms.md')],
    ['the system documentation', join('..', 'docs', 'SYSTEM_DOCUMENTATION.md')],
  ])('wires every /feedback-forms path the embed snippet in %s hands to customers', (_label, relativePath) => {
    // A copy-pasteable snippet is a caller, and it is the one caller whose
    // failure lands on somebody outside this repo. #374 found both of these
    // pages advertising `/feedback-forms/{form_id}/widget.js`, a route neither
    // the handler nor the stack has ever registered — so the snippet returned
    // 403 Missing Authentication Token, which reads as an authorization problem
    // rather than a wrong URL. Prose is checked nowhere else, and the docs are
    // where the wrong path outlived the code by longest.
    //
    // Fenced blocks are read, not the prose around them: the fix for that finding
    // was to state in prose that `widget.js` does NOT exist, so scanning the whole
    // page would fail on the very sentences that prevent the mistake recurring.
    // What is asserted is narrower and is the thing that matters — every URL
    // offered for pasting is one a customer's browser can actually call.
    const page = readRepoFile(...relativePath.split('/'));
    // EVERY fence, whatever its info string — scoping this to ```html was a hole,
    // not a narrowing. Measured on the retired URL: `widget.js` inside a ```js
    // fence passed, and inside ```html title="embed.html" passed, while the same
    // URL in a plain ```html fence failed. Both misses are the exact defect class
    // this test exists to prevent, and neither is exotic: a highlighter tag is
    // cosmetic, and what makes a URL copy-pasteable is the fence, not the label.
    //
    // `[^\n\r]*` consumes the tag and any info string after it, so ```HTML,
    // ```js and ```html title="x" are all read. `\r?` so a CRLF checkout matches;
    // a fence needs the newline straight after its info string, and without it
    // every block misses silently — the no-op the assertion below rules out.
    //
    // Consequence to know before adding examples: an authenticated example in a
    // fence (a `curl` with a bearer token against `submissions`) now fails the
    // unauthenticated check below, correctly by these lights but inconveniently.
    // The fix then is an explicit allowlist of such blocks, not a retreat to
    // reading one tag — which is what let the bad URL through in the first place.
    // Pairing is what makes the scan above sound: the regex consumes fences two at a
    // time, so a single unclosed fence shifts every subsequent pairing and blocks
    // start reading as prose and prose as blocks — silently, which is the one failure
    // mode this whole test exists to avoid. The ```html anchor used to make that
    // harmless. Checked rather than assumed, and cheap. (Currently sound: 6 and 32
    // delimiters. A four-backtick block would still count even here while confusing
    // the scan — no such block exists in either page, and this is the guard that
    // would have to grow if one arrived.)
    const fenceDelimiters = (page.match(/^```/gm) ?? []).length;
    expect(
      fenceDelimiters % 2,
      `odd number of \`\`\` fence delimiters (${fenceDelimiters}) — one is unclosed, so the `
      + 'block scan below is mis-paired and reads prose as code',
    ).toBe(0);

    // BOTH patterns are `^`-anchored with `m`, and they have to be the same shape or
    // the parity check above measures something the scan does not consume. An earlier
    // version counted `/^```/gm` while scanning unanchored: a triple-backtick inside a
    // prose sentence then shifted the scan's pairing while leaving the counted total
    // even, so parity passed and the scan silently read prose as code — the guard not
    // guarding what its own comment claimed. Anchoring fixes it at the source rather
    // than detecting it, since a markdown fence opens at the start of a line anyway.
    const fencedBlocks = [...page.matchAll(/^```[^\n\r]*\r?\n([\s\S]*?)^```/gm)].map(([, body]) => body);

    // Assert the EMBED snippet was found, not merely that some fence was.
    // Counting all fences (or worse, the character length of their joined bodies,
    // which is what this line used to do) is satisfiable by any unrelated block —
    // a theming or <div> example — so moving the embed URL out of its fence into
    // prose would silently reduce the guard to checking nothing while still
    // reporting green. Requiring a fence that actually mentions the route scopes
    // the check to the snippet whose correctness is the point. Retagging no longer
    // matters, which is the point of reading every fence above.
    const formsBlocks = fencedBlocks.filter((body) => body.includes('/feedback-forms'));

    // Reading every fence was the fix for a real hole (see above), but applying the
    // UNAUTHENTICATED oracle to every fence overshoots: these pages are also API
    // references, so the first `curl -H "Authorization: Bearer …" …/submissions`
    // example added to either would fail this test — and the fix a future author
    // reaches for is deleting the example, or narrowing back to one fence tag, which
    // is exactly the regression that let the bad URL through. So the SCAN stays wide
    // and the ORACLE is scoped instead.
    //
    // The discriminator is whether the block pastes a URL into markup a browser
    // loads unattended. Both pages today have exactly one forms-mentioning fence and
    // both are `<iframe src=…>`, so this splits the real content correctly; `src=`
    // also covers the `<script src>` shape the deleted docs used, which is the one
    // most likely to come back.
    const isEmbedContext = (body: string) => body.includes('<iframe') || body.includes('src=');
    const embedBlocks = formsBlocks.filter(isEmbedContext);
    const referenceBlocks = formsBlocks.filter((body) => !isEmbedContext(body));

    expect(
      embedBlocks.length,
      'no fenced block pastes a /feedback-forms path into markup — did the embed snippet move out of its fence, lose its src=, or change path?',
    ).toBeGreaterThan(0);

    // Resolved against the UNAUTHENTICATED subset, unlike the two caller checks
    // above. Those run from an authorized context — `client.ts` carries a Cognito
    // token and the widget source is inlined into a route that is already public
    // — so "is it wired?" is their whole question. A docs snippet is the one
    // caller for which wired is not enough: it executes in a stranger's browser
    // with no credentials on somebody else's site, so pointing it at a wired but
    // Cognito-protected per-form route (`submissions`, `stats`) hands out a
    // 401/403 rather than a form. Asserting only "wired" leaves that green.
    //
    // Derived from the synthesized template rather than from
    // INTENTIONALLY_PUBLIC_ROUTES, keeping this an independent oracle in the
    // same shape as the handler-parity tests above. OPTIONS is excluded the way
    // `nonOptions` does, since generated CORS preflights are unauthenticated by
    // construction and would re-admit every path they cover.
    // One synthesis, two views of it: the unauthenticated subset for pasted markup,
    // every wired method for the rest.
    const methods = nonOptions(apiTemplate());
    const publicPaths = new Set(
      methods.filter((m) => m.authorizationType === 'NONE').map((m) => m.path),
    );
    const wiredPaths = new Set(methods.map((m) => m.path));

    const embedPaths = callerFormsPaths(embedBlocks.join('\n'));
    expect(
      embedPaths.length,
      'an embed block was found but no /feedback-forms path could be extracted from it — '
      + 'the check below would then pass over an empty set',
    ).toBeGreaterThan(0);
    expect(
      embedPaths.filter((path) => !publicPaths.has(path)),
      'the snippet names a path an unauthenticated browser cannot call — it is either unwired or behind Cognito',
    ).toEqual([]);

    // The relaxation is of the oracle, not of the check. A non-embed example may
    // name a Cognito-protected route — that is what an API reference is for — but a
    // path that is wired nowhere is the `widget.js` defect in a different fence, and
    // it 403s for whoever pastes it just the same.
    expect(
      callerFormsPaths(referenceBlocks.join('\n')).filter((path) => !wiredPaths.has(path)),
      'a non-embed example names a /feedback-forms path that is wired nowhere — it answers 403 Missing Authentication Token, not 404',
    ).toEqual([]);
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

  it('throttles both of them below the stage default', () => {
    // The stage default is 100/200 for `/*/*`. These two answer an anonymous
    // caller a DynamoDB read — and `submit` a conditional write — against a
    // bounded room, so they get their own tighter pair. (The widget's `submit`
    // shares it; the two widget reads deliberately do not — see
    // `the public feedback-form routes` below.)
    const settings = new Map(methodSettings(apiTemplate()).map((s) => [s.key, s]));

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


/** ALLOWED_ORIGIN for one API Lambda, by its POWERTOOLS_SERVICE_NAME.
 *
 *  Returns `undefined` when the function exists but names no such variable,
 *  which is a distinct failure from "no such function" and the two assertions
 *  below distinguish them. */
function allowedOriginOf(template: Template, serviceName: string): unknown {
  const EnvSchema = z.object({
    Properties: z.object({
      Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
    }),
  });
  const fn = Object.values(template.findResources('AWS::Lambda::Function')).find(
    (candidate) => EnvSchema.safeParse(candidate).success
      && EnvSchema.parse(candidate).Properties.Environment.Variables.POWERTOOLS_SERVICE_NAME === serviceName,
  );

  expect(fn, `no Lambda found with POWERTOOLS_SERVICE_NAME ${serviceName}`).toBeDefined();
  return EnvSchema.parse(fn).Properties.Environment.Variables.ALLOWED_ORIGIN;
}


describe('the two public sets get OPPOSITE origins, on purpose', () => {
  // Both functions serve unauthenticated routes and they answer the CORS question
  // differently — the forms Lambda takes '*', the ballots Lambda takes the site
  // origin. That difference is a DECISION, not an oversight, so it is pinned from
  // both sides: changing either value alone fails here, and whoever changes one
  // has to say why the other stayed.
  //
  // Forms: the widget (lambda/api/static/feedback-widget.js) is embedded on
  // CUSTOMER sites, so the Origin is a domain this stack cannot enumerate and no
  // single value would work.
  //
  // Ballots: the ballot page is a route of THIS SPA served from its own
  // CloudFront domain, so a phone opening it sends the same Origin every other
  // page does — and '*' there would also loosen the three facilitator routes that
  // share that function.
  it('gives the feedback-form Lambda the deliberate wildcard', () => {
    expect(allowedOriginOf(apiTemplate(), 'voc-feedback-form-api')).toBe('*');
  });

  it('gives the ballots Lambda the site origin', () => {
    // `https://app.example.invalid` is this fixture's `frontendDomainName`
    // interpolated by `allowedOrigin`, i.e. the RESOLVED form of a value a real
    // deploy carries as an Fn::Join over the CloudFront domain. The assertion
    // pins the derivation, not a literal any deployment ever sees.
    expect(allowedOriginOf(apiTemplate(), 'voc-ballots-api')).toBe('https://app.example.invalid');
  });

  it('states the wildcard in the STACK, not in the handler default', () => {
    // feedback_form_handler.py falls back to '*' when the variable is absent, so
    // the effective value was already '*' before this was set — from a Python
    // default, where no reader of the CDK could see it. Asserting the variable is
    // PRESENT is therefore the whole point of this case: a value equal to the
    // handler's fallback is indistinguishable from an omission unless presence is
    // checked on its own.
    expect(allowedOriginOf(apiTemplate(), 'voc-feedback-form-api')).toBeDefined();
  });

  it('keeps the two values distinct, so neither can be "fixed" into the other', () => {
    // TRUE OF THE DEFAULT (PRODUCTION) SHAPE ONLY, and that is not a weakness of
    // the test but a fact about the stack worth stating here: the ballots value
    // comes from `allowedOrigin`, which is `isDev ? '*' : https://<frontend>`, so
    // under `-c environment=dev` it also becomes '*' and the two coincide. The
    // forms value is hardcoded and moves for neither context (see its comment in
    // api-stack.ts). Asserting distinctness under `environment=dev` would
    // therefore be asserting something false.
    const template = apiTemplate();
    const forms = allowedOriginOf(template, 'voc-feedback-form-api');
    const ballots = allowedOriginOf(template, 'voc-ballots-api');

    expect(forms).not.toBe(ballots);
  });

  it('leaves the forms wildcard unmoved by environment=dev, unlike every other Lambda', () => {
    // The divergence the case above describes, asserted rather than only noted.
    // This is the one API Lambda no deployment-time control can tighten: the dev
    // switch that loosens every OTHER API Lambda (each takes
    // `ALLOWED_ORIGIN: allowedOrigin`) reaches everything BUT this value, which is
    // already at its loosest and stays there in both contexts. No count is stated
    // here on purpose — a number drifts as Lambdas are added, and one of those
    // others is not even a CORS consumer (the MCP Lambda uses ALLOWED_ORIGIN as
    // its DNS-rebinding allowlist, see its comment in api-stack.ts).
    const dev = apiTemplateDev();

    expect(allowedOriginOf(dev, 'voc-feedback-form-api')).toBe('*');

    // A FOIL, not a requirement of this change: it shows the switch does move a
    // sibling on the same fixture, which is what makes the line above meaningful.
    // This PR does not own dev-mode CORS, so a future decision to stop loosening
    // `allowedOrigin` to '*' in dev should just update this line — it is not the
    // asymmetry the describe block exists to protect.
    expect(allowedOriginOf(dev, 'voc-ballots-api')).toBe('*');
  });
});


describe('the public feedback-form routes', () => {
  /** The pair each of the three public widget routes carries, and WHY it is not
   *  one pair.
   *
   *  `submit` joins the ballots at 20/40: the request itself is three operations
   *  (form get_item, conditional brand update_item, SQS send_message — it does NOT
   *  write the feedback table, the role is read-only there), and the enqueued
   *  record then drives Comprehend, Translate and a Bedrock invocation in
   *  lambda/processor/handler.py. A per-request model call against a shared
   *  account quota is what the 20 buys protection from.
   *
   *  `config` and `iframe` are stated at 100/200 — the same numbers as the stage
   *  default, deliberately restated rather than inherited. Their legitimate demand
   *  is a CUSTOMER's page-view rate (feedback-widget.js fetches `config` on every
   *  page load; `iframe` renders per embed), the setting is keyed by path so the
   *  ceiling is shared across every form and caller in the deployment, and a 429
   *  surfaces as an unretried "Feedback form unavailable." on `config`
   *  specifically — indistinguishable from a disabled form (`submit` and `iframe`
   *  fail differently again; the three symptoms are enumerated on
   *  publicWidgetReadThrottle in api-stack.ts). So the bounded-room argument
   *  behind 20 rps does not reach them, and pinning their own value keeps a future
   *  tightening of the stage-wide default from silently squeezing a third party's
   *  page.
   *
   *  Keys are `deployOptions.methodOptions`' own form, `{resource path}/{METHOD}`,
   *  and `{form_id}` is the spelling of the resource created as
   *  `feedbackFormsResource.addResource('{form_id}')`. A key naming a path that
   *  does not exist throttles nothing and reports nothing, so the spelling is
   *  compared against the wired routes below rather than trusted. */
  const EXPECTED_FORM_THROTTLES = {
    '/feedback-forms/{form_id}/config/GET': { rate: 100, burst: 200 },
    '/feedback-forms/{form_id}/submit/POST': { rate: 20, burst: 40 },
    '/feedback-forms/{form_id}/iframe/GET': { rate: 100, burst: 200 },
  } satisfies Record<string, { rate: number; burst: number }>;

  /** DERIVED from the record, not maintained beside it. Two hand-kept lists of
   *  the same three keys can disagree, and indexing the record with a key it
   *  lacks reads as `{rate; burst}` to the compiler (`noUncheckedIndexedAccess`
   *  is off in this tsconfig), so a mismatch would surface as "cannot read
   *  properties of undefined" instead of naming the missing key. The case that
   *  needs the pairs iterates `Object.entries` for the same reason: no indexing,
   *  so no unchecked lookup to get wrong. */
  const PUBLIC_FORM_METHOD_KEYS = Object.keys(EXPECTED_FORM_THROTTLES);

  /** The substring a document uses to name a route, and the method-setting key
   *  whose numbers that row must state. The short forms are what the two
   *  documents actually write (`POST /submit`, not the full path), so they are
   *  what a line has to contain to be judged.
   *
   *  The ballot routes are here as well as the three form routes, answering a
   *  review question rather than only the task's scope. They share
   *  `publicRouteThrottle` with the widget's `submit` today, so they cannot drift
   *  from it while that constant is shared — but the named follow-up (a per-form
   *  submission cap) is precisely the thing that would DECOUPLE them, moving the
   *  form figure and leaving the ballot prose behind with the suite still green.
   *
   *  BOTH ballot routes are named, by FULL PATH, and that is the fix for a hole
   *  review found in the version that named only the ballot's config: a line
   *  spelled `POST /voting-sessions/{session_id}/submit` contains `/submit`, was
   *  shadowed by nothing, and was judged against the FORM's submit pair. It passed
   *  only because both are 20/40 — that is, precisely until the follow-up above
   *  decouples them, at which point a correct document fails and accuses itself.
   *  Registering the route is what closes it, because the shadowing rule below is
   *  containment between a doc-facing NAME and another route's KEY: once the
   *  ballot's submit path is a name, it shadows `/submit` with no new mechanism,
   *  and — the half a family-based rule would have missed — the line is judged
   *  against the ballot submit's OWN pair rather than against the ballot config's.
   *
   *  Hence full paths for the ballot pair and short names for the form: each is
   *  what its own document writes, which is the rule stated above. */
  const DOCUMENTED_ROUTE_KEYS = {
    '/config': '/feedback-forms/{form_id}/config/GET',
    '/iframe': '/feedback-forms/{form_id}/iframe/GET',
    '/submit': '/feedback-forms/{form_id}/submit/POST',
    '/voting-sessions/{session_id}/config': '/voting-sessions/{session_id}/config/GET',
    '/voting-sessions/{session_id}/submit': '/voting-sessions/{session_id}/submit/POST',
  } satisfies Record<string, string>;

  /** Every document that publishes these figures, and which routes each one
   *  publishes. THE SINGLE SOURCE for both cases below, which is the point: the
   *  lockstep case READS these files, and the class-level guard EXEMPTS them from
   *  its "no third document states these unpinned" sweep.
   *
   *  Two separately-maintained copies of this list is the defect review found —
   *  adding a third document to the guard's copy alone silenced the guard (the
   *  file counts as pinned) while the lockstep never read it (its own list was
   *  untouched), so a document publishing 999/999 passed the whole block. The
   *  guard's failure message even pointed at the OTHER list, making the half-fix
   *  the natural one. Derived over one declaration, adding a document is one edit
   *  that necessarily does both, which is the same reasoning as
   *  `PUBLIC_FORM_METHOD_KEYS` being `Object.keys` of the record above.
   *
   *  Typed against `DOCUMENTED_ROUTE_KEYS`, so a route name that no longer exists
   *  fails to compile instead of quietly asserting nothing for it. */
  const PINNED_DOCS = {
    'docs/feedback-forms.md': ['/config', '/iframe', '/submit'],
    '.kiro/steering/structure.md': [
      '/config', '/iframe', '/submit',
      '/voting-sessions/{session_id}/config', '/voting-sessions/{session_id}/submit',
    ],
  } satisfies Record<string, (keyof typeof DOCUMENTED_ROUTE_KEYS)[]>;

  /** Every spelling of a per-second rate, as an un-anchored alternation. THE
   *  SHARED VOCABULARY of the two doc cases below, and shared for the same reason
   *  `PINNED_DOCS` is: two hand-kept copies disagreed, and the disagreement was
   *  invisible in both.
   *
   *  The lockstep case SELECTS candidate lines with it; the class-level guard
   *  DISCOVERS documents with it. Those two keep their opposite biases — see the
   *  comment on `statesALimit` — but a spelling one of them recognises and the
   *  other does not is a gap rather than a bias, and review found the gap it
   *  produced: discovery accepted `requests/second`, selection accepted only
   *  `rps` / `req/s`, so a pinned document reworded to the broad-only spelling
   *  stayed discovered while none of its lines was judged, and the failure that
   *  followed named the document rather than the parse.
   *
   *  Longest alternatives first, so `requests/second` is not consumed as
   *  `requests/s` with `econd` left over. The trailing `\/\s*s` is the bare
   *  `100/s` form. */
  const RATE_UNIT = String.raw`requests? per second|requests?\/sec(?:ond)?|req\/sec(?:ond)?|requests?\/s|req\/s|rps|\/\s*s`;

  /** The documented names that are about a MORE SPECIFIC route than `names`: their
   *  route key CONTAINS this name, so a line naming them is not a line about this
   *  route.
   *
   *  `/voting-sessions/{session_id}/config/GET` contains `/config`, so a ballot row
   *  spelled with its full path — which the steering file already does for the form
   *  (`/feedback-forms/{id}/config`) — would otherwise be selected for `/config`
   *  and judged against the FORM's 100/200, failing as a stale ceiling while
   *  correctly publishing the ballot's 20/40. Reproduced before fixing: rewriting
   *  the ballot row that way fails with "stale for /config: this row states 20/40
   *  but the template deploys 100/200".
   *
   *  Today's ballot row writes `/{id}/…` and so does not collide — this is one
   *  full-path rewording away, and the failure it produces accuses a document that
   *  is correct. A separate function so `attributes a line to the most specific
   *  route it names` can pin it without needing a document that collides. */
  const moreSpecificThan = (names: string) => Object.entries(DOCUMENTED_ROUTE_KEYS)
    .filter(([other, key]) => other !== names && key.includes(names))
    .map(([other]) => other);

  /** Whether `line` is a documentation row ABOUT `names`.
   *
   *  ONE definition, used by the lockstep loop and by `attributes a line to the
   *  most specific route it names`. Splitting them is what a mutation caught: with
   *  the test calling `moreSpecificThan` and the loop applying the exclusion
   *  inline, disabling the loop's copy left every case green — the helper was
   *  pinned and its USE was not, which is the same shape as the duplicated lists
   *  this block already fixed twice.
   *
   *  Containment is the ONLY rule, and an intermediate version of this fix had a
   *  second one — shadowing by route FAMILY, so that a line naming one family's
   *  root was never a row about the other. It is deleted rather than kept: naming
   *  the ballot's submit route in `DOCUMENTED_ROUTE_KEYS` closes the same hole
   *  through the rule already here, and does it BETTER, because a family rule
   *  excludes the ballot submit line from the form's pair while still judging it
   *  against the ballot CONFIG's pair — the same wrong-pair failure one route
   *  over, waiting for the same follow-up to decouple them. One mechanism that
   *  judges every named route against its own pair beats two that share a hole. */
  const isRowFor = (names: string, line: string) => line.includes(names)
    // A more specific route, whichever family it belongs to:
    // `/voting-sessions/{session_id}/config/GET` contains `/config`, and
    // `/voting-sessions/{session_id}/submit/POST` contains `/submit`.
    && !moreSpecificThan(names).some((other) => line.includes(other));

  /** A stated rate FIGURE: digits immediately followed by one of those units.
   *
   *  Both predicates below use THIS, not a bare `RATE_UNIT`, and the digits are
   *  the whole correction. Sharing only the unit made selection as wide as
   *  discovery, and two legitimate lines then hard-failed as "states no rate pair
   *  this test can parse" — the false positive the comment on `statesALimit` says
   *  the precise bias exists to avoid:
   *
   *    - `The /submit route sustains roughly 30x what the feature needs in
   *      requests per second.` — prose that names a route and a unit, claims no
   *      figure, and was judged as though it had.
   *    - `| /submit | write | Sized for 50 MB/s of payload … |` — the bare
   *      `\/\s*s` alternative matches ANY `<word>/s`, so `MB/s`, `GB/s`, `ops/s`
   *      and `reads/s` all counted as stating a rate.
   *
   *  Both reproduced against the real documents before this changed. Requiring the
   *  digits makes selection match what `allStatedPairs` can actually parse, which
   *  is the property that was missing: a line is judged only if a rate figure is
   *  there to judge. `50 MB/s` no longer qualifies because the digits are not
   *  adjacent to the unit — `MB` sits between them.
   *
   *  Discovery gets the same treatment on purpose, and it does not lose reach for
   *  its job: a third document that PUBLISHES one of these ceilings states it in
   *  digits, which is the only form the lockstep can pin anyway (its own failure
   *  message says "digits, not words"). What discovery stops doing is flagging a
   *  document for mentioning throughput in prose. The two predicates keep their
   *  opposite biases where the comment says those live — SCOPE (whole file versus
   *  one line) and the anchored burst — not in what counts as a figure.
   *
   *  IT CAPTURES THE FIGURE, in group 1, so that `allStatedPairs` can be BUILT from
   *  this string instead of re-spelling it. Review found the re-spelling: the parser
   *  wrote its own `(\d+)\s*(?:${RATE_UNIT})` while its comment asserted the prefix
   *  was "exactly `RATE_FIGURE`" — an equality the compiler cannot check, and the
   *  same two-hand-kept-copies shape this block has already fixed for `PINNED_DOCS`
   *  and `PUBLIC_FORM_METHOD_KEYS`. They agreed at the time, which is what makes it
   *  worth fixing before they stop agreeing: the invariant the comment names (a line
   *  that is SELECTED is a line the parser can PARSE) is load-bearing, and breaking
   *  it in either direction produces one of the two failures described above.
   *
   *  The capture is inert for the selector — `RegExp.test` ignores groups — so one
   *  constant serves both without either paying for the other. */
  const RATE_FIGURE = String.raw`(\d+)\s*(?:${RATE_UNIT})\b`;

  it('gives each of the three an explicit pair, tight for submit and generous for the reads', () => {
    const settings = new Map(methodSettings(apiTemplate()).map((s) => [s.key, s]));

    for (const [key, expected] of Object.entries(EXPECTED_FORM_THROTTLES)) {
      const setting = settings.get(key);

      expect(setting, `${key} has no method-level throttle`).toBeDefined();
      expect(setting?.rate).toBe(expected.rate);
      expect(setting?.burst).toBe(expected.burst);
    }
  });

  it('holds submit strictly tighter than the two reads, which is the whole split', () => {
    // The pins above would still pass if all three were "fixed" back to one pair.
    // This is the case that fails then: the asymmetry is the decision, and it is
    // argued from cost (a Bedrock invocation per submission) versus demand (a
    // third party's page views), not from who is allowed to call.
    const settings = new Map(methodSettings(apiTemplate()).map((s) => [s.key, s]));
    const submit = settings.get('/feedback-forms/{form_id}/submit/POST');

    for (const read of ['/feedback-forms/{form_id}/config/GET', '/feedback-forms/{form_id}/iframe/GET']) {
      expect(submit?.rate, `submit should be tighter than ${read}`)
        .toBeLessThan(settings.get(read)?.rate ?? 0);
    }
  });

  it('spells those throttle keys the same way the wired routes are spelled', () => {
    const wired = new Set(apiMethods(apiTemplate()).map((m) => `${m.path}/${m.httpMethod}`));

    expect(PUBLIC_FORM_METHOD_KEYS.filter((key) => !wired.has(key))).toEqual([]);
  });

  it('drops the throttle entries when skipFeedbackFormItemRoutes omits the routes', () => {
    // The transitional deploy does not create the {form_id} subtree at all, so a
    // method setting naming those paths would be a claim about routes this stage
    // does not serve. Harmless to API Gateway — an unmatched setting is simply
    // never applied — but the template should not assert what it does not deploy.
    const keys = new Set(methodSettings(apiTemplateFlagged()).map((s) => s.key));

    expect(PUBLIC_FORM_METHOD_KEYS.filter((key) => keys.has(key))).toEqual([]);

    // The ballot entries are unaffected: the flag is named for the form routes and
    // taking a prioritization meeting's throttle down with it would be unrelated.
    expect(keys.has('/voting-sessions/{session_id}/config/GET')).toBe(true);
    expect(keys.has('/voting-sessions/{session_id}/submit/POST')).toBe(true);
  });

  it('every method setting on the stage names a route this stage wires', () => {
    // The general form of the two cases above, over BOTH template shapes: a
    // setting whose path is not deployed is dead weight, and this is what makes
    // the conditional above self-enforcing rather than a one-off.
    for (const template of [apiTemplate(), apiTemplateFlagged()]) {
      const wiredKeys = new Set(apiMethods(template).map((m) => `${m.path}/${m.httpMethod}`));
      const orphans = methodSettings(template)
        .map((s) => s.key)
        // `*/*` is the STAGE-WIDE default that `throttlingRateLimit` /
        // `throttlingBurstLimit` on deployOptions produce. It names no resource
        // by design and is the one form API Gateway accepts as a wildcard.
        .filter((key) => key !== '*/*')
        .filter((key) => {
          const path = key.slice(0, key.lastIndexOf('/'));
          const verb = key.slice(key.lastIndexOf('/') + 1);
          // `/mcp/{proxy+}/…` keys name concrete verbs served by the proxy's ANY.
          return !wiredKeys.has(`${path}/${verb}`) && !wiredKeys.has(`${path}/ANY`);
        });

      expect(orphans).toEqual([]);
    }
  });

  it('CORS preflight is unauthenticated and reaches no compute, which is why it is excluded above', () => {
    // The two facts `nonOptions` rests on, asserted rather than described. Review
    // asked whether the OPTIONS methods belong in the "every unauthenticated route
    // is throttled" invariant; they do belong to the concern, and this is why they
    // are already satisfied by the stage default.
    //
    // NEITHER fact is a count. The number of preflights changes with every route
    // added, so pinning it would fail on unrelated work; what must hold is that
    // ALL of them are still MOCK and still NONE.
    for (const template of [apiTemplate(), apiTemplateFlagged(), apiTemplateAllPlugins()]) {
      const preflights = apiMethods(template).filter((m) => m.httpMethod === 'OPTIONS');
      expect(preflights.length, 'no OPTIONS methods at all — CORS is not wired, so this is vacuous').toBeGreaterThan(0);

      // Unauthenticated by necessity: a browser sends no credentials on a preflight.
      expect(
        [...new Set(preflights.map((m) => m.authorizationType))],
        'a preflight gained an authorizer, which breaks CORS for every caller',
      ).toEqual(['NONE']);

      // MOCK is the load-bearing one: it is why an unauthenticated preflight needs
      // no per-method pair. A Lambda-backed OPTIONS would cost real compute per
      // call and would have to join EXPECTED_FORM_THROTTLES' treatment instead.
      // Parsed, not asserted — this file's convention for template values.
      const PreflightSchema = z.object({
        Properties: z.object({
          HttpMethod: z.string(),
          Integration: z.object({ Type: z.string().optional() }).optional(),
        }),
      });
      const backed = Object.entries(template.findResources('AWS::ApiGateway::Method'))
        .filter(([, resource]) => {
          const { HttpMethod, Integration } = PreflightSchema.parse(resource).Properties;
          return HttpMethod === 'OPTIONS' && Integration?.Type !== 'MOCK';
        })
        .map(([logicalId]) => logicalId);

      expect(
        backed,
        'an OPTIONS method is no longer a MOCK integration, so a preflight now reaches compute — '
        + 'it needs its own throttle pair, and `nonOptions` must stop excluding it',
      ).toEqual([]);
    }
  });

  it('gives EVERY unauthenticated route an explicit throttle, not just these three', () => {
    // The CONVERSE of the case above, and the one that generalises this PR rather
    // than pinning its three routes. The orphan check asks "does every setting
    // name a wired route?"; this asks "does every route that needs a setting have
    // one?" Without it, a SIXTH public route added later passes every other test
    // in this file while silently riding the stage default — which is exactly the
    // gap that existed for these three before this change, so leaving only the
    // per-key pins would fix the instance and not the class.
    //
    // Quantified over the unauthenticated routes the TEMPLATE declares, not over
    // INTENTIONALLY_PUBLIC_ROUTES, so it needs no maintenance: publishing a route
    // puts it in scope here automatically.
    //
    // THREE shapes, and the third is the one that makes this non-vacuous for the
    // scenario named above. The realistic "sixth public route" in this repo is a
    // PLUGIN WEBHOOK: api-stack.ts adds them as `pluginResource.addMethod(method,
    // webhookIntegration)` with no method options, i.e. deliberately
    // AuthorizationType NONE. Those exist only when plugins are enabled, so with
    // apiTemplate()/apiTemplateFlagged() alone (both synthesized with
    // `enabledSources: []`) the route this case should flag would not be in any
    // template it inspects. apiTemplateAllPlugins() is the fixture the sibling
    // authorization invariant already uses for exactly this reason. No manifest
    // declares a webhook today, so this adds no failure now and starts working on
    // the day one does.
    for (const template of [apiTemplate(), apiTemplateFlagged(), apiTemplateAllPlugins()]) {
      const settings = new Map(methodSettings(template).map((s) => [s.key, s]));
      const explicitPair = (key: string) =>
        settings.get(key)?.rate !== undefined && settings.get(key)?.burst !== undefined;
      const unthrottled = unauthenticatedRoutes(template)
        // `GET /a/b` is keyed `/a/b/GET` in deployOptions.methodOptions.
        .map((route) => {
          const [verb, path] = route.split(' ');
          return { path, verb, key: `${path}/${verb}` };
        })
        // A rate limit with no burst, or vice versa, is not an explicit pair: the
        // missing half falls back to the stage or account default silently.
        //
        // `ANY` needs the same allowance the orphan check above makes, and for the
        // converse reason. A route wired through `addProxy({ anyMethod: true })`
        // reports httpMethod ANY, but API Gateway REJECTS `ANY` as a method-setting
        // httpMethod (the deploy-probe finding recorded on methodOptions in
        // api-stack.ts), so demanding `/…/{proxy+}/ANY` would make this case
        // unsatisfiable rather than merely strict — it would fail against a
        // correct, maximally-throttled stack. For such a method, a concrete-verb
        // setting on the SAME path is the throttled form, which is how the /mcp
        // proxy entries are spelled.
        //
        // "Same path" is compared by splitting each setting key at its LAST `/`
        // and requiring equality, not with `startsWith`. A prefix test also
        // matches DESCENDANTS, so a setting on `/webhooks/some-plugin/POST` would
        // excuse an un-throttled ANY method on `/webhooks` — a false negative, and
        // the wrong direction for a guard whose job is to flag a public route
        // riding the stage default.
        //
        // NO CURRENT FIXTURE EXERCISES THIS BRANCH: no manifest declares a webhook
        // (pinned by the sibling case above), and every `addProxy({ anyMethod:
        // true })` in api-stack.ts passes `authMethodOptions`, so no template here
        // holds an unauthenticated ANY route. Its correctness rests on reading
        // rather than on a passing assertion — which is why the predicate is
        // written to be exact rather than merely sufficient for today's template.
        .filter(({ path, verb, key }) => (verb === 'ANY'
          ? ![...settings.keys()].some((k) => k.slice(0, k.lastIndexOf('/')) === path && explicitPair(k))
          : !explicitPair(key)))
        .map(({ key }) => key);

      expect(unthrottled, 'public routes riding the stage default').toEqual([]);
    }
  });

  it('attributes a line to the most specific route it names', () => {
    // Pins `moreSpecificThan`, which stops a BALLOT row being judged against the
    // FORM's ceiling. Pinned here rather than through the documents because
    // neither document collides today — the exposure is one full-path rewording
    // away, so a fixture is the only way to keep the guard honest.
    //
    // The relationship is containment between a doc-facing NAME and another
    // route's KEY, not string length: `/voting-sessions/{session_id}/config/GET`
    // contains `/config`, which is what makes a ballot row look like a form row.
    expect(moreSpecificThan('/config')).toEqual(['/voting-sessions/{session_id}/config']);

    // THE SAME RELATIONSHIP FOR SUBMIT, which review found missing. With the ballot
    // pair named by its config alone, `/submit` was shadowed by nothing, so a line
    // spelled `POST /voting-sessions/{session_id}/submit` was judged against the
    // FORM's submit pair, passing only because both are 20/40 — until the per-form
    // cap follow-up moves one of them. Naming the ballot's submit route brings it
    // under the containment rule that was already here.
    expect(moreSpecificThan('/submit')).toEqual(['/voting-sessions/{session_id}/submit']);

    // And the converse, which is what stops this over-reaching: the ballot routes are
    // named by full path, so nothing is more specific than either, and `/iframe`
    // appears in no other key. If these returned a value, rows would start being
    // skipped rather than misjudged — the opposite failure.
    expect(moreSpecificThan('/voting-sessions/{session_id}/config')).toEqual([]);
    expect(moreSpecificThan('/voting-sessions/{session_id}/submit')).toEqual([]);
    expect(moreSpecificThan('/iframe')).toEqual([]);

    // The selection rule itself: a line naming a ballot route is not a form row, and
    // a line naming only the form's short name still is.
    // `isRowFor` itself, the SAME predicate the lockstep loop filters with — not a
    // restatement of it here. A local copy left the loop's use of it unpinned.
    const ballotConfigRow = '> `GET /voting-sessions/{session_id}/config` carries 20 rps / 40';
    const ballotSubmitRow = '> `POST /voting-sessions/{session_id}/submit` carries 20 rps / 40';
    const formRow = '> | `GET /config`, `GET /iframe` | **100 rps / 200** |';
    const formSubmitRow = '> | `POST /submit` | **20 rps / 40** |';

    expect(isRowFor('/config', ballotConfigRow), 'a ballot row must not be judged as a form row').toBe(false);
    expect(isRowFor('/voting-sessions/{session_id}/config', ballotConfigRow)).toBe(true);

    // The pair that fails without the ballot submit route registered: the ballot's
    // submit line is not the form's row, and it IS judged — against its OWN pair,
    // which is the half a family-based exclusion would have got wrong (it would
    // have judged this line against the ballot CONFIG's pair instead).
    expect(isRowFor('/submit', ballotSubmitRow), 'a ballot submit row must not be judged as the form submit row').toBe(false);
    expect(isRowFor('/voting-sessions/{session_id}/submit', ballotSubmitRow)).toBe(true);
    expect(isRowFor('/voting-sessions/{session_id}/config', ballotSubmitRow)).toBe(false);
    expect(isRowFor('/voting-sessions/{session_id}/submit', ballotConfigRow)).toBe(false);

    // And the form's own rows are still its rows, which is what over-reach breaks.
    expect(isRowFor('/config', formRow)).toBe(true);
    expect(isRowFor('/submit', formSubmitRow)).toBe(true);
  });

  it('counts a rate FIGURE, not a bare unit, so prose about throughput is not judged', () => {
    // The predicate both doc cases select and discover with, pinned directly.
    //
    // Reaching it through the real documents is not enough: both defects below
    // were found by a reviewer, not by this suite, because they are exposures to
    // the NEXT line either document gains — every line present today happens to
    // state a well-formed pair. Measured: with the digits removed the real-doc
    // lockstep still PASSES, so the shapes are named here, where a revert fails
    // immediately rather than on the next doc edit.
    //
    // Reproduced against the real docs/feedback-forms.md before fixing: each
    // `MUST_NOT_SELECT` row, appended to that file, failed the lockstep case with
    // "states no rate pair this test can parse" — a legitimate line accused of
    // being a stale ceiling.
    const selects = (line: string) => new RegExp(RATE_FIGURE).test(line);

    const MUST_SELECT = [
      '| `/submit` | 5 req/s, burst 10 |',
      '| `/config` | **100 rps / 200** |',
      'the reads allow 100 requests per second, burst 200',
      'documented as 100 requests/second, burst 200',
      'the bare form, 100/s / 200, is also accepted',
    ];
    const MUST_NOT_SELECT = [
      // Names a route and a unit; claims no figure. Judged as though it had.
      'The `/submit` route sustains roughly 30x what the feature needs in requests per second.',
      // The bare `\/\s*s` alternative matches any `<word>/s`.
      '| `/submit` | write | Sized for 50 MB/s of payload, not room-sized bursts. |',
      'throughput of 12 GB/s across the fleet',
      'the handler manages 40 ops/s per shard',
      // A path segment must never read as a rate.
      'see /feedback-forms/{form_id}/submissions for the reads',
      // AND THE ONE THAT ACTUALLY EXERCISES THE TRAILING `\b`, which review found
      // this list was missing: the row above carries no digits, so it is rejected
      // for want of a figure whatever `\b` does — vacuous cover for the guard it
      // was added for. Here `1/s` (stage `v1`, then a segment starting with `s`)
      // DOES match `\d+` followed by the bare `\/\s*s` unit, and only the boundary
      // rejects it, because `ubmissions` continues the word. Drop the `\b` and this
      // line reads as "1 per second" and gets judged against the template.
      'the raw reads live under /v1/submissions in the deployed stage',
    ];

    for (const line of MUST_SELECT) {
      expect(selects(line), `should be judged but was not selected: ${line}`).toBe(true);
    }
    for (const line of MUST_NOT_SELECT) {
      expect(selects(line), `states no figure but was selected for judgement: ${line}`).toBe(false);
    }
  });

  it('keeps the two prose copies of these numbers in step with the template', () => {
    // The pairs are stated in FIVE places: the two constants in api-stack.ts, the
    // record above, and two documents — docs/feedback-forms.md (integrator-facing)
    // and .kiro/steering/structure.md. The first three are enforced against the
    // synthesized template by the cases above; without this, the two prose copies
    // drift silently on the next tuning and mislead the exact reader they were
    // added for.
    //
    // A .md file is a new thing for this suite to read, but not a new IDEA: the
    // `stack and callers stay in step` block already reads feedback_form_handler.py,
    // ballots_handler.py, api.py and api-stack.ts itself, and the Python side
    // carries a family of *_lockstep tests for constants shared across languages.
    // A number published as an integrator-facing contract is exactly the kind of
    // claim this repo pins rather than trusts, so the docs are held to the same
    // standard as the code — that is the answer to "should prose stay unpinned":
    // no, when it states a number a deploy can contradict.
    //
    // Deliberately asserts only the NUMBERS, and only on the lines that state a
    // limit for the route: the prose around them is explanatory and should stay
    // free to be reworded without a test edit. Where a route IS named with a
    // limit, EVERY such line must state the template's pair — see the per-row
    // comparison below for the false pass that "some line does" allowed.
    //
    // PER ROUTE rather than per document, which a first version got wrong and a
    // mutation caught: searching the whole file for "100 … 200" passes even after
    // `config`'s row is falsified, because `iframe` legitimately carries the same
    // pair elsewhere in the file. Scoping the search to lines that name the route
    // is what makes a single stale row fail. The docs are read from the repo ROOT,
    // one level above `voc-datalake`.
    //
    // That scoping fixed the CROSS-ROUTE false pass and left the WITHIN-LINE one.
    // Any "do these digits occur on the line" predicate is satisfied by a row that
    // states the WRONG limit and mentions the right one in passing — `| GET /config
    // | 20 rps / 40 | was 100 rps / 200 before |` matches 100/200 — and prose beside
    // a number ("raised from 100 to 250", or a "Why" column citing another route's
    // figures) is exactly how a doc goes stale.
    //
    // Requiring the two numbers to be ADJACENT does not close it either: in `was
    // 100 rps / 200 before` the correct pair IS adjacent, so that row still passes.
    // Checked against the falsified row before settling on the predicate below.
    //
    // So it is not a search. Each candidate line is PARSED for the pair it STATES
    // and that pair is compared to the template's numerically: the property
    // asserted is "this row is correct", not "the right digits are present
    // somewhere on it". Both phrasings parse: "100 req/s, burst 200" and
    // "**100 rps / 200**".
    //
    // And the parse is NOT POSITIONAL, which is the second half of the same defect.
    // Taking the FIRST pair on the line just picks whichever of two well-formed
    // pairs comes first, so the stale row survives with its clauses reversed:
    // `| GET /config | raised from 100 rps / 200 to **250 rps / 500** |` parses as
    // 100/200, matches, and passes while the document publishes 250/500 — and
    // "raised from X to Y" is the more natural phrasing of the two, since it reads
    // chronologically. So every pair on the line is collected and a candidate row
    // must state EXACTLY ONE, which removes the ordering question instead of
    // answering it. Both orderings were checked against the real documents.
    //
    // Candidates are lines that STATE A LIMIT, i.e. that name the route AND carry
    // a rate token, rather than every line mentioning the route. That is what keeps
    // two kinds of line out of the candidate set: the embed snippet in
    // docs/feedback-forms.md (`src="…/{form_id}/iframe"`, which carries a digit in
    // `/v1/` and so survives a bare digit filter), and the 429-symptom table, whose
    // rows name each route and say nothing about its ceiling. A "must be a markdown
    // table row" test would exclude the snippet too, but not the symptom rows, and
    // it would exclude the BALLOT figure below, which is stated in prose.
    const settings = new Map(methodSettings(apiTemplate()).map((s) => [s.key, s]));

    for (const [names, key] of Object.entries(DOCUMENTED_ROUTE_KEYS)) {
      // Guards the case itself: an absent setting would search for "undefined" and
      // every assertion below would fail confusingly rather than say what is wrong.
      expect(settings.get(key), `${names} has no method-level throttle to document`).toBeDefined();
    }

    /** A line stating a rate limit, in ANY spelling of a per-second rate the
     *  discovery guard below recognises — `RATE_FIGURE` is shared with it rather
     *  than restated here, and that sharing is the point.
     *
     *  The two predicates keep their OPPOSITE BIASES, which is what earlier
     *  rounds established and this deliberately does not undo: discovery is
     *  evaluated over the WHOLE FILE (over-inclusive, so a drifting third
     *  document cannot hide), while this one is evaluated PER
     *  LINE and the parse below additionally demands an anchored burst (precise,
     *  so a legitimate line is not failed). What they must not disagree about is
     *  the VOCABULARY, and they did: discovery accepted `requests/second` and
     *  `req/sec` while this accepted only `rps` and `req/s`, so a pinned document
     *  reworded to a broad-only spelling stayed DISCOVERED (satisfying the
     *  converse assertion) while every line of it stopped being a candidate here —
     *  and the `rows.length > 0` guard then reported "documents no rate limit for
     *  /config" about a document that plainly states one. The guard fired, so
     *  nothing drifted silently, but it named the wrong cause and pointed the
     *  author at the document instead of at the parse. Reproduced before fixing.
     *
     *  One alternation removes the class rather than the instance: any spelling
     *  either predicate recognises, both recognise. The biases live in the SCOPE
     *  and in the burst anchoring, not in the list of words for "per second".
     *
     *  A FIGURE, not just a unit — `RATE_FIGURE` requires digits adjacent to the
     *  unit. Selecting on the bare unit made this as wide as discovery and failed
     *  two legitimate lines; see `RATE_FIGURE`. */
    const statesALimit = (line: string) => new RegExp(RATE_FIGURE).test(line);

    /** EVERY `<rate> <per-second unit> <separator> <burst>` pair a line states, in order.
     *
     *  All of them, not the first, and that is the whole point. Parsing the FIRST
     *  pair is still positional, so it picks whichever of two well-formed pairs
     *  comes first and the stale-row defect survives with the clauses reversed:
     *  `raised from 100 rps / 200 to **250 rps / 500**` parses as 100/200, matches
     *  the template, and passes while the document publishes 250/500. Verified
     *  against the real steering doc before this was widened.
     *
     *  THE BURST IS ANCHORED TO THE TOKEN THAT INTRODUCES IT, not to "the next
     *  digits anywhere after the rate". An unanchored `[^0-9]*` spans any run of
     *  non-digits, so a row publishing NO burst still parsed one by adopting an
     *  unrelated later number — `| 100 req/s | burst raised in PR 200 |` yielded
     *  100/200, matched the template, satisfied the exactly-one check, and passed
     *  while telling an integrator nothing about the burst. A PR number, an issue
     *  reference, a version or a percentage later in the row was enough, and the
     *  row need not even be wrong on purpose, just reworded. Reproduced before
     *  fixing; that is the same class as the two defects the previous round fixed,
     *  one field over.
     *
     *  Both real phrasings put a word or a bare `/` immediately before the burst —
     *  `100 req/s, burst 200` and `**100 rps / 200**` — so requiring one of those
     *  two separators accepts every current row and yields ZERO pairs for a row
     *  that states no burst, which then fails as "states no parseable pair" rather
     *  than passing.
     *
     *  The rate-and-unit prefix here IS `RATE_FIGURE` — concatenated, not restated,
     *  which is the correction review asked for. `RATE_FIGURE` is what
     *  `statesALimit` selects with, so a line that is selected is a line this can
     *  parse — that equality is the invariant, and losing it in either direction
     *  is a defect this file has already seen twice. A NARROWER unit here would
     *  report "states no rate pair this test can parse" for a spelling the
     *  selector had just accepted; a WIDER selector would judge a line that never
     *  claimed a figure, which is what requiring the digits fixed.
     *
     *  It used to be a second spelling of that prefix with this comment claiming
     *  they were "exactly" equal. They were, so nothing was broken — but a comment
     *  is not a check, and the two copies could only stay equal by hand. Building
     *  the pattern from the constant makes the invariant hold by construction, so
     *  widening the vocabulary in one place cannot leave the other behind. Group 1
     *  is the rate, captured by `RATE_FIGURE`; group 2 is the burst, captured here. */
    const allStatedPairs = (line: string): { rate: number; burst: number }[] =>
      [...line.matchAll(new RegExp(RATE_FIGURE + String.raw`\s*(?:,\s*burst\s+|\/\s*)(\d+)`, 'g'))]
        .map((match) => ({ rate: Number(match[1]), burst: Number(match[2]) }));

    for (const [doc, routes] of Object.entries(PINNED_DOCS)) {
      const lines = readFileSync(join(__dirname, '..', '..', '..', ...doc.split('/')), 'utf-8').split('\n');

      for (const names of routes) {
        const setting = settings.get(DOCUMENTED_ROUTE_KEYS[names]);
        // The steering file groups the two reads onto one row, so a route may be
        // documented by more than one line — and EVERY such line is judged, not
        // just one of them. See the loop below for why that changed.
        const rows = lines.filter((line) => isRowFor(names, line) && statesALimit(line));

        expect(rows.length, `${doc} documents no rate limit for ${names}`).toBeGreaterThan(0);

        // EXACTLY ONE pair per line, which removes the ordering question rather
        // than answering it. Every candidate row in both documents states exactly
        // one today, so this costs nothing now and forces a future "was 100/200"
        // aside — the phrasing that defeats any positional parse — onto its own
        // line or into a footnote, where it cannot be mistaken for the row's
        // claim. Checked before adopting: no current row states two.
        //
        // TWO ASSERTIONS, NOT ONE `toBe(1)`. A single two-sided assertion can only
        // carry one message, and the one it carried described only the greater-than
        // side: a row stating ZERO parseable pairs failed with "states more than
        // one … move the aside to its own line", advising an author to split a row
        // that has nothing to split, with `expected +0 to be 1` the only clue that
        // the diagnosis was inverted. Reproduced verbatim by spelling a burst in
        // words. The zero case is not hypothetical — it is reached by omitting the
        // burst, spelling it in words, or any rewording the parse stops matching,
        // and it is the state the anchored burst above now correctly produces for a
        // row that publishes no burst, so the two interact. Assertion messages here
        // are load-bearing, so a message that misdescribes the failure it fires on
        // is a defect rather than a wording nit.
        //
        // AND EVERY ROW IS COMPARED TO THE TEMPLATE, which is the last member of
        // the family the two previous rounds worked through — the same defect one
        // level up, ACROSS rows rather than within a line. The comparison used to
        // be a single `toContainEqual` over `rows.flatMap(allStatedPairs)`, which
        // pooled the pairs of every candidate row and asked only that the correct
        // one appear SOMEWHERE in the pool. So one correct row satisfied the
        // assertion on behalf of every other row naming the route, and the loop
        // here did not cover that: it bounded each row's pair COUNT and never
        // compared a row's pair to anything. Review reproduced it by ADDING a row
        // beside the correct one:
        //
        //     | `GET /…/config` | 100 req/s, burst 200 |
        //     | `GET /…/config` (legacy deployments) | 20 req/s, burst 40 |
        //
        // The pool was [{100,200},{20,40}], `toContainEqual({100,200})` passed, and
        // the document told an integrator that `/config` is 20 req/s. Adding a row
        // is how a document grows — a version caveat, a "self-hosted" note, a
        // per-tier table — so this is the more likely direction of drift than the
        // single-row cases already closed.
        //
        // Judging each row subsumes the pooled check, so it is gone rather than
        // kept alongside. It stays satisfiable for the legitimate multi-row case
        // the pooling was written for: the steering doc's `GET /config`, `GET
        // /iframe` row is matched by BOTH route names and states the pair both
        // expect, so requiring every row to agree passes unchanged. `rows.length >
        // 0` above still carries the "documented nowhere" case, which per-row
        // judgement cannot express.
        for (const row of rows) {
          const pairs = allStatedPairs(row);

          expect(
            pairs.length,
            `${doc} names ${names} and carries a rate token but states no rate pair this test can `
            + 'parse, so nothing pins it — write it as "100 req/s, burst 200" or "100 rps / 200" '
            + `(digits, not words): ${row.trim()}`,
          ).toBeGreaterThan(0);

          expect(
            pairs.length,
            `${doc} states more than one rate pair on one line for ${names}, so which one the row `
            + `CLAIMS is ambiguous — move the aside to its own line: ${row.trim()}`,
          ).toBeLessThan(2);

          expect(
            pairs[0],
            `${doc} is stale for ${names}: this row states ${pairs[0]?.rate}/${pairs[0]?.burst} but the `
            + `template deploys ${setting?.rate}/${setting?.burst} — EVERY row naming the route must `
            + `agree, a correct row elsewhere does not excuse this one: ${row.trim()}`,
          ).toEqual({ rate: setting?.rate, burst: setting?.burst });
        }
      }
    }
  });

  it('finds no THIRD document stating these numbers unpinned', () => {
    // The case above reads an ENUMERATED LIST OF TWO FILES, which is the same "fix
    // the instance, not the class" shape the converse throttle invariant was added
    // to avoid: a third document stating these figures would drift with nothing
    // to stop it, and nothing would point that out. This is the class-level half —
    // it enumerates every markdown file in the repository and fails if one states
    // a rate limit for these routes without being in the pinned list.
    //
    // Cheap enough to be worth it (a few dozen small files) and it answers the
    // second half of the review question: prose is not exempt, and the exemption
    // is not obtained by writing the numbers somewhere the lockstep does not look.
    //
    // The predicate below is DELIBERATELY OVER-INCLUSIVE, which is the opposite
    // bias from `statesALimit` in the case above, and the two remain separate
    // FUNCTIONS for exactly that reason. `statesALimit` picks lines out of two
    // KNOWN documents, so a false positive there fails a legitimate line and it
    // must be precise. This one has to DISCOVER unknown documents written by
    // someone who never read this test, so a false negative silently excuses a
    // drifting file while a false positive only asks an author to pin the file or
    // drop the figures. Two consequences, both found by review:
    //
    //   - IT DEMANDS ONLY A UNIT, not a parseable rate/burst pair. Requiring the
    //     anchored pair the lockstep parses would miss a third document that
    //     states the rate and omits the burst, or states it in words — exactly the
    //     document that most needs pinning. The lockstep is strict about the pair
    //     because it must judge a row; this only needs to notice the subject.
    //   - IT IS EVALUATED OVER THE WHOLE FILE, not per line. Requiring the route
    //     and the rate on ONE line misses a table styled like the steering doc's
    //     own, whose route column reads `POST /submit` while only the heading says
    //     `/feedback-forms`. That gap also made `.kiro/steering/structure.md`
    //     itself discoverable ONLY via its ballot prose sentence — so a reword of
    //     one line about a DIFFERENT feature would have turned the converse
    //     assertion below red for an unrelated reason.
    //
    // WHAT IS NO LONGER A DIFFERENCE is the VOCABULARY. This predicate once
    // carried its own, wider list of spellings, on the reasoning that a third
    // author reaches for "a different word for per second" — sound reasoning, but
    // it left the two disagreeing over a set of spellings, and review showed the
    // gap that opened: a PINNED document reworded to `100 requests/second, burst
    // 200` stayed discovered here (so the converse assertion was satisfied) while
    // no line of it was a candidate in the lockstep, which then failed with
    // "documents no rate limit for /config" about a document that states one. The
    // guard fired, so nothing drifted silently, but it accused the document
    // instead of the parse. Both now share `RATE_FIGURE`, so anything wide enough
    // to be DISCOVERED is wide enough to be JUDGED, and the biases live where they
    // belong: in the scope (file vs line) and in the burst anchoring.
    //
    // Sharing the UNIT alone was the first attempt and it over-corrected: it made
    // selection as wide as discovery, so prose naming a route and any `<word>/s`
    // throughput was judged as though it had stated a ceiling. `RATE_FIGURE` adds
    // the digits both sides actually need — see its comment for the two lines that
    // failed.
    //
    // Verified over the tree: whole-file scope with the shared figure flags exactly
    // the two pinned documents and nothing else, so the over-inclusion costs no
    // false positive today.
    const ROOT = join(__dirname, '..', '..', '..');
    /** THE SAME DECLARATION the lockstep case above reads, not a second copy of
     *  the same two paths. Two separately-maintained lists could disagree, and
     *  review demonstrated the half-fix they invited: appending a stale table to a
     *  third document and adding it HERE ONLY — the edit this case's own failure
     *  message most directly suggests, since this is the list literally named
     *  "pinned" — left the whole block green with that document publishing
     *  999/999. This case stopped complaining (the file is now pinned) and the
     *  lockstep never read it (its list was untouched). One declaration makes
     *  adding a document necessarily both pin it and exempt it. */
    const PINNED = Object.keys(PINNED_DOCS);
    const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.venv', 'cdk.out']);

    const markdownFiles = (dir: string, prefix = ''): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : markdownFiles(join(dir, entry.name), rel);
        return entry.name.endsWith('.md') ? [rel] : [];
      });

    const ROUTES = ['/feedback-forms', '/voting-sessions'];
    /** Any spelling of a per-second rate FIGURE — `RATE_FIGURE`, the SAME shared
     *  pattern the lockstep case selects and parses with, so the two cannot
     *  disagree about which spellings count. */
    const STATES_A_RATE = new RegExp(RATE_FIGURE);
    const stating = markdownFiles(ROOT).filter((rel) => {
      const text = readFileSync(join(ROOT, ...rel.split('/')), 'utf-8');
      return STATES_A_RATE.test(text) && ROUTES.some((route) => text.includes(route));
    });

    expect(
      stating.filter((rel) => !PINNED.includes(rel)).sort(),
      'a markdown file states a public-route rate limit but is not read by the lockstep case above — '
      + 'add it to PINNED_DOCS (which both pins and exempts it, naming the routes it publishes), '
      + 'or remove the figures and point at api-stack.ts',
    ).toEqual([]);

    // And the converse: a pinned document that stops stating them would leave the
    // case above asserting nothing, so both must still be in the discovered set.
    expect(
      PINNED.filter((rel) => !stating.includes(rel)),
      'a document in PINNED_DOCS no longer states any public-route rate limit, so the lockstep case '
      + 'above is now asserting nothing for it — restore the figures or drop it from PINNED_DOCS',
    ).toEqual([]);

    // THE THIRD DIRECTION, and the one neither assertion above covers: a route
    // that no document publishes at all.
    //
    // Both checks above are about DOCUMENTS — is this file pinned, does a pinned
    // file still state figures. Neither looks at ROUTES, so deleting a route from
    // every PINNED_DOCS array leaves both green while the lockstep silently stops
    // asserting anything about that route's ceiling: its loop simply iterates one
    // route fewer. `DOCUMENTED_ROUTE_KEYS` would still name it, and the throttle
    // pins above would still check the template, so the only thing lost is the
    // prose-versus-template lockstep — quietly, which is this whole block's
    // stated failure mode applied to itself.
    //
    // Every key in DOCUMENTED_ROUTE_KEYS must therefore appear in at least one
    // pinned document's route list. That is also the invariant that makes the
    // `satisfies` type meaningful in the other direction: the type stops a route
    // name that does not EXIST, this stops a route that exists and is UNREAD.
    // `Set<string>`, not the inferred union: the keys being compared come from
    // `Object.keys`, which is typed `string[]`.
    const documentedSomewhere = new Set<string>(Object.values(PINNED_DOCS).flat());
    expect(
      Object.keys(DOCUMENTED_ROUTE_KEYS).filter((names) => !documentedSomewhere.has(names)),
      'a route in DOCUMENTED_ROUTE_KEYS appears in no PINNED_DOCS array, so the lockstep case above '
      + 'iterates past it and nothing checks its published ceiling against the template — add it to '
      + 'the document that publishes it, or drop it from DOCUMENTED_ROUTE_KEYS',
    ).toEqual([]);
  });

  // No "adds no public route" case here: that is `VocApiStack authorization
  // invariant`'s first test, which pins both the contents and the count of
  // INTENTIONALLY_PUBLIC_ROUTES once for the whole file.
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
  it('throttles the MCP methods below the stage default', () => {
    const settings = new Map(methodSettings(apiTemplate()).map((s) => [s.key, s]));
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
    //
    // The trailing comma is NOT required by the match, and that matters: requiring it
    // meant a tuple written without one silently lost its LAST entry, and a partial
    // parse fails in the permissive direction — fewer headers checked, with nothing
    // saying so, guarded only by the `>= 3` control below. The recovered count is
    // cross-checked against the declaration lines so a drifted parse fails outright.
    const entryLines = (block ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    const names = [...(block ?? '').matchAll(/([A-Z_]+)\s*,?/g)].map((m) => m[1]);
    expect(names.length, 'TRANSPORT_HEADERS looks empty').toBeGreaterThan(0);
    expect(
      names.length,
      `recovered ${names.length} names from ${entryLines.length} declaration lines in `
      + 'TRANSPORT_HEADERS: the regex and the Python literal have drifted. Keep one '
      + 'named constant per line, or update this parse.',
    ).toBe(entryLines.length);
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

  // `mcp_handler.py` now sends `Vary: Authorization` on every response, because its
  // answers depend on the credential and the caches in front of this endpoint read
  // headers rather than the JSON-RPC body's `cacheScope`. `Vary` is not
  // CORS-safelisted, so a browser receives it and hides it from the page unless the
  // endpoint says otherwise — the same failure `WWW-Authenticate` already documents.
  //
  // Read out of the Python source for the same reason as the allow-list above: the
  // handler's own responses carry ITS expose list and gateway-GENERATED ones (the
  // authorizer's 401) carry the template's, so a header exposed by one and not the
  // other is readable on some of this endpoint's answers and not others.
  //
  // ⚠️ This parse reads a single-quoted STRING LITERAL, so it breaks if that value is
  // ever rewritten as a `','.join((...))` expression the way `Access-Control-Allow-
  // Headers` above it already is — which is the likelier of the two ways to break it,
  // because making the two neighbouring keys consistent is an obvious tidy-up. The
  // Python declaration carries a note saying so.
  const pythonExposeHeaders = (): string[] => {
    const source = readRepoFile('lambda', 'api', 'mcp_handler.py');
    const value = source.match(
      /^\s*'Access-Control-Expose-Headers':\s*'([^']+)',/m,
    )?.[1];
    expect(value, "could not read Access-Control-Expose-Headers from mcp_handler.py")
      .toBeDefined();
    return (value ?? '').split(',').map((h) => h.trim());
  };

  it('exposes every response header the handler expects a browser to read', () => {
    const declared = pythonExposeHeaders();
    // Positive control: a regex that matched nothing would make the loop vacuous.
    // Both of the non-safelisted headers the handler adds are named, so a parse that
    // recovered only part of the list fails here rather than checking less.
    expect(declared.map((h) => h.toLowerCase())).toContain('vary');
    expect(declared.map((h) => h.toLowerCase())).toContain('allow');

    const responses = Object.values(
      apiTemplate().findResources('AWS::ApiGateway::GatewayResponse'),
    );
    const ResponseSchema = z.object({
      Properties: z.object({
        ResponseType: z.string(),
        ResponseParameters: z.record(z.string(), z.string()).optional(),
      }),
    });
    const parsed = responses.map((r) => ResponseSchema.parse(r).Properties);
    const withExpose = parsed.filter((props) => props.ResponseParameters?.[
      'gatewayresponse.header.Access-Control-Expose-Headers'
    ]);
    expect(withExpose.length, 'no gateway response publishes an expose list')
      .toBeGreaterThan(0);

    for (const props of withExpose) {
      const raw = props.ResponseParameters?.[
        'gatewayresponse.header.Access-Control-Expose-Headers'
      ] as string;
      const exposed = new Set(
        raw.replace(/^'|'$/g, '').split(',').map((h) => h.trim().toLowerCase()),
      );
      for (const header of declared) {
        expect(
          exposed,
          `${header} is exposed by the handler but not by the ${props.ResponseType} response`,
        ).toContain(header.toLowerCase());
      }
    }
  });

  it('tells a cache the authorizer 401 varies by credential', () => {
    // The 401 is the most credential-dependent answer this API gives, and the
    // authorizer produces it — so the `Vary` the handler sends never reaches it.
    // Without this, an intermediary could cache that refusal against the endpoint
    // alone and serve it to a request carrying a perfectly good credential.
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
      .filter((props) => props.ResponseType === 'UNAUTHORIZED');

    expect(unauthorized.length, 'no UNAUTHORIZED gateway response in the template')
      .toBe(1);
    const vary = unauthorized[0].ResponseParameters?.['gatewayresponse.header.Vary'];
    expect(vary, 'the UNAUTHORIZED response sends no Vary').toBeDefined();
    expect((vary ?? '').toLowerCase()).toContain('authorization');
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
    // The challenge must be READABLE, which is the property this line is about —
    // asserted as membership rather than as the whole list, because the list also
    // carries `Content-Type` and `Vary` and pinning it exactly made this test fail
    // when an unrelated header was exposed. 'mcp transport headers reach a browser'
    // owns the completeness of the list; this owns the challenge being in it.
    const exposed = (params['gatewayresponse.header.Access-Control-Expose-Headers'] ?? '')
      .replace(/^'|'$/g, '').split(',').map((h) => h.trim().toLowerCase());
    expect(exposed).toContain('www-authenticate');
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


describe('prototype object IAM boundaries', () => {
  const StatementSchema = z.object({
    Effect: z.string(),
    Action: z.union([z.string(), z.array(z.string())]),
    Resource: z.unknown(),
    Condition: z.unknown().optional(),
  });
  const PolicySchema = z.object({
    Properties: z.object({
      PolicyDocument: z.object({ Statement: z.array(StatementSchema) }),
    }),
  });

  function statementsForRole(roleName: string): z.infer<typeof StatementSchema>[] {
    const policies = apiTemplate().findResources('AWS::IAM::Policy');
    const policy = Object.entries(policies).find(([logicalId]) => logicalId.includes(roleName));
    expect(policy, `no IAM policy found for ${roleName}`).toBeDefined();
    return PolicySchema.parse(policy?.[1]).Properties.PolicyDocument.Statement;
  }

  it('denies Data Explorer prototype writes without denying reads or other prefixes', () => {
    const denies = statementsForRole('DataExplorerLambdaRole')
      .filter((statement) => statement.Effect === 'Deny');

    expect(denies).toHaveLength(1);
    const actions = Array.isArray(denies[0].Action) ? denies[0].Action : [denies[0].Action];
    expect(actions.sort()).toEqual(['s3:DeleteObject', 's3:PutObject']);
    const resources = Array.isArray(denies[0].Resource)
      ? denies[0].Resource
      : [denies[0].Resource];
    expect(resources).toHaveLength(1);
    expect(JSON.stringify(resources[0])).toContain('prototypes/*');
  });

  it('keeps the document generator read-write grant scoped to prototype objects', () => {
    const prototypeStatements = statementsForRole('DocumentGeneratorRole')
      .filter((statement) => JSON.stringify(statement.Resource).includes('prototypes/*'));

    expect(prototypeStatements.length).toBeGreaterThan(0);
    const actions = new Set(prototypeStatements.flatMap((statement) => (
      Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    )));
    expect(actions).toContain('s3:GetObject*');
    expect(actions).toContain('s3:PutObject');
    expect(actions).toContain('s3:DeleteObject*');
    expect(actions).not.toContain('s3:*');
  });

  // DELETE /projects/{id} sweeps the prototype objects the project owns, so the
  // projects role needs exactly two prototype actions and no others. Pinned in
  // both directions: a grantReadWrite reached for "for consistency" would hand it
  // read and write access to every other project's prototype HTML, which is the
  // content `/prototypes/*` exists to keep behind a signature.
  describe('the projects role prototype sweep grant', () => {
    const prototypeStatements = () => statementsForRole('ProjectsLambdaRole')
      .filter((statement) => JSON.stringify(statement).includes('prototypes/'));

    it('grants delete on prototype objects and nothing more on them', () => {
      const objectStatements = prototypeStatements()
        .filter((statement) => JSON.stringify(statement.Resource).includes('prototypes/*'));

      expect(objectStatements).toHaveLength(1);
      const actions = Array.isArray(objectStatements[0].Action)
        ? objectStatements[0].Action
        : [objectStatements[0].Action];
      expect(actions).toEqual(['s3:DeleteObject']);
      expect(objectStatements[0].Effect).toBe('Allow');
    });

    it('scopes the bucket-level list to the prototypes prefix', () => {
      // ListBucket is a BUCKET action, so an unconditioned grant would let this
      // role enumerate avatars, product docs and every import in the bucket.
      const listStatements = prototypeStatements()
        .filter((statement) => (
          Array.isArray(statement.Action) ? statement.Action : [statement.Action]
        ).includes('s3:ListBucket'));

      expect(listStatements).toHaveLength(1);
      expect(JSON.stringify(listStatements[0].Resource)).not.toContain('prototypes/');
      expect(listStatements[0].Condition).toStrictEqual({
        StringLike: { 's3:prefix': ['prototypes/*'] },
      });
    });

    it('gains no read or write on prototype objects', () => {
      const actions = new Set(prototypeStatements().flatMap((statement) => (
        Array.isArray(statement.Action) ? statement.Action : [statement.Action]
      )));

      for (const forbidden of ['s3:*', 's3:GetObject', 's3:GetObject*', 's3:PutObject']) {
        expect(actions, `projects role must not carry ${forbidden} on prototypes`)
          .not.toContain(forbidden);
      }
    });
  });
});


function stateMachineDefinitionText(value: unknown): string {
  if (typeof value === 'string') return value;
  const joined = z.object({
    'Fn::Join': z.array(z.unknown()),
  }).safeParse(value);
  if (!joined.success) return '';
  const pieces = joined.data['Fn::Join'][1];
  if (!Array.isArray(pieces)) return '';
  return pieces
    .filter((piece): piece is string => typeof piece === 'string')
    .join('');
}

function documentWorkflowDefinition(template: Template): string {
  const resourceSchema = z.object({
    Properties: z.object({
      DefinitionString: z.unknown(),
    }),
  });
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  for (const resource of Object.values(machines)) {
    const parsed = resourceSchema.safeParse(resource);
    if (!parsed.success) continue;
    const definition = stateMachineDefinitionText(
      parsed.data.Properties.DefinitionString,
    );
    if (definition.includes('DocGather')) return definition;
  }
  throw new Error('Document workflow state machine was not synthesized');
}

describe('document workflow replay routing', () => {
  const state: { definition: string } = { definition: '' };
  beforeAll(() => {
    state.definition = documentWorkflowDefinition(synthApiTemplate());
  });

  it('selects the replay marker from the gather Lambda result', () => {
    expect(state.definition).toContain(
      '"replayed.$":"$.Payload.replayed"',
    );
  });

  it('completes committed replays and runs fresh allocations', () => {
    expect(state.definition).toContain('"DocumentAlreadyGenerated"');
    expect(state.definition).toContain(
      '"Variable":"$.gathered.replayed","BooleanEquals":true,"Next":"DocComplete"',
    );
    expect(state.definition).toContain('"Default":"DocStep0"');
  });
});
