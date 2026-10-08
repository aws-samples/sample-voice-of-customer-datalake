/**
 * Test support: the synthesized `VocApiStack` the api-stack suites assert over.
 *
 * One builder and one set of cached template shapes (default, all plugins,
 * prefixed + fixture provider, `skipFeedbackFormItemRoutes`, dev origin), plus
 * the readers that turn a template back into routes, method settings and
 * resolvable handlers. The suites were one 3,600-line file; they share this so
 * the split did not copy the parsing into each of them.
 *
 * Caches are per test FILE: vitest isolates modules per file, so each suite
 * synthesizes the shapes it uses at most once.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { VocApiStack } from '../stacks/api-stack';
import { apiStackDependencyProps, indexedTableFactory } from './api-stack-fixture';
import { byCodeUnit } from '../utils/compare';
import { itemAt } from './guards';

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
export const INTENTIONALLY_PUBLIC_ROUTES = [
  'GET /feedback-forms/{form_id}/config',
  'GET /feedback-forms/{form_id}/iframe',
  'GET /voting-sessions/{session_id}/config',
  'POST /feedback-forms/{form_id}/submit',
  'POST /voting-sessions/{session_id}/submit',
];

/** `/mcp` uses a custom Lambda token authorizer because MCP clients cannot run
 *  the Cognito flow. Authenticated, just not by Cognito. */
export const CUSTOM_AUTHORIZER_ROUTE_PREFIXES = ['/mcp'];

/** Plugin webhook receivers that exist only when their plugin is ENABLED, so they
 *  appear in `apiTemplateAllPlugins()` and never in `apiTemplate()`. Unauthenticated
 *  at the gateway by necessity (the provider cannot hold a Cognito token) and
 *  authenticated in the handler by the provider's signature — github_issues checks
 *  `X-Hub-Signature-256` (HMAC-SHA256, constant-time) before parsing anything.
 *
 *  THE SAME REVIEW GATE as INTENTIONALLY_PUBLIC_ROUTES: a new entry is somebody
 *  choosing to publish a route, and a webhook declared without one fails the
 *  authorization invariant until it is added here. */
export const INTENTIONALLY_PUBLIC_WEBHOOK_ROUTES = [
  'POST /webhooks/github_issues',
];

export const PLUGINS_DIR = join(__dirname, '..', '..', 'plugins');

/**
 * Every plugin on disk, enumerated rather than hardcoded — a hardcoded list would
 * make a newly registered plugin invisible to both the all-plugins invariant and
 * the webhook pin below, i.e. exactly the case they exist to catch.
 *
 * `plugins/` also holds Python test files, `__pycache__`, `_shared/` and
 * `_template/` (which does have a manifest.json), so filter the way
 * `loadPlugins` does: a directory with a manifest, not `_`-prefixed.
 */
export function discoverPluginIds(): string[] {
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .filter((entry) => existsSync(join(PLUGINS_DIR, entry.name, 'manifest.json')))
    .map((entry) => entry.name)
    .sort(byCodeUnit);
}

export function buildApiStack(
  context: Record<string, unknown> = {},
  enabledSources: string[] = [],
  deploymentPrefix?: string,
  aspects: cdk.IAspect[] = [],
): VocApiStack {
  // Skip asset bundling (Docker) and the frontend-freshness guard — template
  // assertions only need structure, and the check would make the suite depend
  // on whether frontend/dist happens to be newer than frontend/src.
  const app = new cdk.App({
    context: { 'aws:cdk:bundling-stacks': [], skipFrontendBuildCheck: true, ...context },
  });
  const env = { account: '111111111111', region: 'us-east-1' };
  const deps = new cdk.Stack(app, 'TestDeps', { env });

  // The real Projects/Aggregates tables carry GSIs, and that detail is
  // load-bearing for IAM assertions: `Table.grant()` expands to the table ARN
  // *plus* `<table>/index/*` only when an index exists. Without one here, a
  // wide grant and a table-scoped statement synthesize identically and every
  // wildcard assertion in these suites is vacuous.
  const table = indexedTableFactory(deps);

  const stack = new VocApiStack(app, 'TestApiStack', {
    env,
    deploymentPrefix,
    ...apiStackDependencyProps(deps, env, table),
    brandName: 'TestBrand',
    enabledSources,
  });

  // Added after construction but before any synth, which is when aspects run.
  for (const aspect of aspects) cdk.Aspects.of(app).add(aspect);
  return stack;
}

export function synthApiTemplate(
  context: Record<string, unknown> = {},
  enabledSources: string[] = [],
  deploymentPrefix?: string,
): Template {
  return Template.fromStack(buildApiStack(context, enabledSources, deploymentPrefix));
}

// Synthesizing is the expensive part of the suite and most tests want the same
// template, so cache the two shapes that get reused.
let cachedDefault: Template | undefined;
let cachedAllPlugins: Template | undefined;

/** No plugins enabled. */
export function apiTemplate(): Template {
  cachedDefault ??= synthApiTemplate();
  return cachedDefault;
}

/** Every plugin on disk enabled — the shape a real deployment has. */
export function apiTemplateAllPlugins(): Template {
  cachedAllPlugins ??= synthApiTemplate({}, discoverPluginIds());
  return cachedAllPlugins;
}

/**
 * The only shape carrying verification-only infrastructure: a prefixed
 * (side-by-side) deployment that ALSO opts in explicitly. Both are required —
 * a prefixed production slot must not get it by topology alone — and a default
 * deploy must stay byte-identical, which lib/app-baseline.test.ts asserts.
 */
let cachedPrefixed: Template | undefined;
export function apiTemplatePrefixed(): Template {
  cachedPrefixed ??= synthApiTemplate({ enableVerificationFixtureProvider: true }, [], 'b');
  return cachedPrefixed;
}

/** The transitional first-deploy shape. */
let cachedFlagged: Template | undefined;
export function apiTemplateFlagged(): Template {
  cachedFlagged ??= synthApiTemplate({ skipFeedbackFormItemRoutes: true });
  return cachedFlagged;
}

/** `-c environment=dev`, the shape that loosens `allowedOrigin` to '*'. Cached
 *  like the other three, so calling any of these repeatedly inside a case costs
 *  a map lookup rather than another synth. */
let cachedDev: Template | undefined;
export function apiTemplateDev(): Template {
  cachedDev ??= synthApiTemplate({ environment: 'dev' });
  return cachedDev;
}

// Template values arrive as `unknown`; parse rather than assert (no `as`).
export const RefSchema = z.object({ Ref: z.string() });
const GetAttSchema = z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) });
const ResourceIdSchema = z.union([RefSchema, GetAttSchema]);
type ResourceId = z.infer<typeof ResourceIdSchema>;

const ApiResourceSchema = z.object({ PathPart: z.string(), ParentId: ResourceIdSchema });
const MethodSchema = z.object({
  HttpMethod: z.string(),
  ResourceId: ResourceIdSchema,
  AuthorizationType: z.string().optional(),
  AuthorizerId: z.unknown().optional(),
  Integration: z.object({ Uri: z.unknown().optional() }).optional(),
});

interface ApiMethod {
  httpMethod: string;
  path: string;
  authorizationType: string;
  hasAuthorizerId: boolean;
  route: string;
  /** Logical id of the Lambda the integration invokes, when it invokes one. */
  integrationFunctionId: string | undefined;
}

/** The direct children of a JSON value: array items, object values, or none. */
function jsonChildren(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null) return Object.values(value);
  return [];
}

/** The function a Lambda-proxy integration URI points at.
 *
 *  CDK renders the URI as an `Fn::Join` whose parts include
 *  `{ 'Fn::GetAtt': [<function logical id>, 'Arn'] }` — or, for a SnapStart
 *  function integrated through its published alias (lib/utils/snapstart.ts),
 *  `{ Ref: <alias logical id> }`, resolved here to the alias's function. A MOCK
 *  integration (CORS preflight) has no URI and yields `undefined`. */
function integrationFunctionId(uri: unknown, aliasFunctions: ReadonlyMap<string, string>): string | undefined {
  const getAtt = GetAttSchema.safeParse(uri);
  if (getAtt.success) return getAtt.data['Fn::GetAtt'][1] === 'Arn' ? getAtt.data['Fn::GetAtt'][0] : undefined;
  const ref = RefSchema.safeParse(uri);
  if (ref.success) return aliasFunctions.get(ref.data.Ref);
  for (const child of jsonChildren(uri)) {
    const found = integrationFunctionId(child, aliasFunctions);
    if (found !== undefined) return found;
  }
  return undefined;
}

const AliasPropertiesSchema = z.object({ FunctionName: RefSchema });

/** Alias logical id -> logical id of the function it points at. */
export function aliasFunctionIds(template: Template): Map<string, string> {
  return new Map(Object.entries(template.findResources('AWS::Lambda::Alias')).map(([aliasId, alias]) => (
    [aliasId, AliasPropertiesSchema.parse(alias.Properties).FunctionName.Ref]
  )));
}

/**
 * Reconstructs each method's full path by walking `ParentId` up the
 * AWS::ApiGateway::Resource chain. The root is an `Fn::GetAtt
 * [<api>, RootResourceId]`, which terminates the walk.
 */
export function apiMethods(template: Template): ApiMethod[] {
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

  const aliasFunctions = aliasFunctionIds(template);
  return Object.values(template.findResources('AWS::ApiGateway::Method')).map((method) => {
    const parsed = MethodSchema.parse(method.Properties);
    const path = pathOf(parsed.ResourceId) || '/';
    return {
      httpMethod: parsed.HttpMethod,
      path,
      authorizationType: parsed.AuthorizationType ?? 'NONE',
      hasAuthorizerId: parsed.AuthorizerId !== undefined,
      route: `${parsed.HttpMethod} ${path}`,
      integrationFunctionId: integrationFunctionId(parsed.Integration?.Uri, aliasFunctions),
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
export const nonOptions = (template: Template) => apiMethods(template).filter((m) => m.httpMethod !== 'OPTIONS');
export const unauthenticatedRoutes = (template: Template) =>
  nonOptions(template).filter((m) => m.authorizationType === 'NONE').map((m) => m.route).sort(byCodeUnit);

/** `value` without any trailing `/`, trimmed without a backtracking-prone regex. */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.at(end - 1) === '/') end -= 1;
  return value.slice(0, end);
}

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
  const path = withoutTrailingSlashes(itemAt(raw.split('?'), 0));
  return path.replace(/^\/feedback-forms\/[^/]+/, '/feedback-forms/{form_id}');
}

/** Every `/feedback-forms...` path mentioned in a source file. */
export function callerFormsPaths(source: string): string[] {
  const matches = source.match(/\/feedback-forms(?:\/[^\s'"`?)]*)?/g) ?? [];
  return [...new Set(matches.map(normalizeFormsPath))].sort(byCodeUnit);
}

export const readRepoFile = (...segments: string[]) => readFileSync(join(__dirname, '..', '..', ...segments), 'utf-8');

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
export function methodSettings(template: Template): { key: string; rate?: number; burst?: number }[] {
  const stages = Object.values(template.findResources('AWS::ApiGateway::Stage'));

  expect(stages.length, 'expected exactly one API stage').toBe(1);

  return (StageSchema.parse(stages[0]).Properties.MethodSettings ?? []).map((s) => ({
    key: `${decodePath(s.ResourcePath)}/${s.HttpMethod}`,
    rate: s.ThrottlingRateLimit,
    burst: s.ThrottlingBurstLimit,
  }));
}

/** Logical id of the one Lambda whose handler is `<module>.lambda_handler`. */
export function functionIdForHandler(template: Template, handlerFile: string): string {
  const handler = `${handlerFile.replace(/\.py$/, '')}.lambda_handler`;
  const ids = Object.keys(template.findResources('AWS::Lambda::Function', { Properties: { Handler: handler } }));
  expect(ids, `expected exactly one function with Handler ${handler}`).toHaveLength(1);
  return itemAt(ids, 0);
}

/** How specifically one resource path segment matches one route segment:
 *  literal 2, `{param}` 1, `{proxy+}` 0, no match -1. A Powertools `<param>` is
 *  an ARBITRARY value, so only a `{param}`/`{proxy+}` resource can serve it — a
 *  literal sibling (say `/feedback/urgent` beside `/feedback/{id}`) cannot. */
function segmentScore(resourceSegment: string, routeSegment: string): number {
  if (/^\{\w+\+\}$/.test(resourceSegment)) return 0;
  if (/^\{\w+\}$/.test(resourceSegment)) return 1;
  return resourceSegment === routeSegment && !/^<\w+>$/.test(routeSegment) ? 2 : -1;
}

/** Per-segment specificity of `resourcePath` against `routePath`, or undefined
 *  if the resource cannot serve that route. A trailing `{proxy+}` matches one or
 *  more remaining segments (never zero: `/a/{proxy+}` does not serve `/a`).
 *  Parameter NAMES are ignored on purpose — Powertools matches the concrete path
 *  positionally (see 'delegates only to routes API Gateway wires'). */
function matchScores(resourcePath: string, routePath: string): number[] | undefined {
  const resource = resourcePath.split('/').filter(Boolean);
  const route = routePath.split('/').filter(Boolean);
  const scores: number[] = [];
  for (const [index, segment] of resource.entries()) {
    const greedy = /^\{\w+\+\}$/.test(segment);
    if (greedy) return index === resource.length - 1 && route.length > index ? [...scores, 0] : undefined;
    const routeSegment = route.at(index);
    if (routeSegment === undefined) return undefined;
    const score = segmentScore(segment, routeSegment);
    if (score < 0) return undefined;
    scores.push(score);
  }
  return resource.length === route.length ? scores : undefined;
}

const compareScores = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** The method API Gateway would route `verb path` to: among methods for that
 *  verb (or ANY) whose resource can serve the path, the most specific resource,
 *  compared segment by segment from the root as API Gateway does. */
export function resolveMethod(methods: ApiMethod[], verb: string, path: string): ApiMethod | undefined {
  return methods
    .filter((m) => m.httpMethod === verb || m.httpMethod === 'ANY')
    .map((m) => ({ m, scores: matchScores(m.path, path) }))
    .filter((c): c is { m: ApiMethod; scores: number[] } => c.scores !== undefined)
    .sort((a, b) => compareScores(b.scores, a.scores) || (a.m.httpMethod === 'ANY' ? 1 : 0) - (b.m.httpMethod === 'ANY' ? 1 : 0))[0]?.m;
}

/** A Lambda's handler and environment, parsed rather than asserted. */
export const LambdaEnvSchema = z.object({
  Properties: z.object({
    Handler: z.string().optional(),
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }).optional(),
  }),
});

const ServiceEnvSchema = z.object({
  Properties: z.object({
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
  }),
});

/** Environment variables of the one API Lambda whose POWERTOOLS_SERVICE_NAME is
 *  `serviceName`; fails the calling test (and returns `{}`) when there is none. */
export function serviceEnvironment(template: Template, serviceName: string): Record<string, unknown> {
  const fn = Object.values(template.findResources('AWS::Lambda::Function'))
    .map((candidate) => ServiceEnvSchema.safeParse(candidate).data?.Properties.Environment.Variables)
    .find((variables) => variables?.POWERTOOLS_SERVICE_NAME === serviceName);
  expect(fn, `no Lambda found with POWERTOOLS_SERVICE_NAME ${serviceName}`).toBeDefined();
  return fn ?? {};
}

const PolicyStatementsSchema = z.object({
  Properties: z.object({
    PolicyDocument: z.object({
      Statement: z.array(z.object({
        Action: z.union([z.string(), z.array(z.string())]),
        Resource: z.unknown(),
        Condition: z.unknown().optional(),
      })),
    }),
  }),
});

/** One statement of {@link policyStatementsOf}: actions as a list, the resource serialized. */
export interface RolePolicyStatement {
  actions: string[];
  resource: string;
  condition: unknown;
}

/** Statements of the first IAM policy whose logical id contains `roleFragment`
 *  (a role's default policy is named after the role); fails the calling test
 *  when there is none. */
export function policyStatementsOf(template: Template, roleFragment: string): RolePolicyStatement[] {
  const policy = Object.entries(template.findResources('AWS::IAM::Policy'))
    .find(([id]) => id.includes(roleFragment));
  expect(policy, `no IAM policy found for ${roleFragment}`).toBeDefined();
  if (policy === undefined) return [];
  return PolicyStatementsSchema.parse(policy[1]).Properties.PolicyDocument.Statement.map((s) => ({
    actions: Array.isArray(s.Action) ? s.Action : [s.Action],
    resource: JSON.stringify(s.Resource),
    condition: s.Condition,
  }));
}

/** Sorted, de-duplicated actions starting with `prefix` across `statements`. */
export function actionsWithPrefix(statements: readonly { actions: string[] }[], prefix: string): string[] {
  return [...new Set(statements.flatMap((s) => s.actions).filter((action) => action.startsWith(prefix)))].sort(byCodeUnit);
}

/** The `{path}/{METHOD}` method-setting keys among `keys` that name no wired method. */
export function unwiredMethodKeys(template: Template, keys: readonly string[]): string[] {
  const wired = new Set(apiMethods(template).map((m) => `${m.path}/${m.httpMethod}`));
  return keys.filter((key) => !wired.has(key));
}

/** The stage throttle pair for each of `keys`, `undefined` where a key has no
 *  method setting — shaped so one `toStrictEqual` pins every pair at once. */
export function methodThrottles(
  template: Template,
  keys: readonly string[],
): Record<string, { rate?: number; burst?: number } | undefined> {
  const settings = new Map(methodSettings(template).map((s) => [s.key, s]));
  return Object.fromEntries(keys.map((key) => {
    const setting = settings.get(key);
    return [key, setting && { rate: setting.rate, burst: setting.burst }];
  }));
}
