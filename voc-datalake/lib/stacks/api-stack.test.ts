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
import { readFileSync } from 'node:fs';
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

/** The only routes that may be served without credentials: the embeddable
 *  widget runs on the customer's own site. `config` and `submit` are fetched
 *  by lambda/api/static/feedback-widget.js; `iframe` is navigated to directly
 *  by the browser in the iframe embed variant. */
const INTENTIONALLY_PUBLIC_ROUTES = [
  'GET /feedback-forms/{form_id}/config',
  'GET /feedback-forms/{form_id}/iframe',
  'POST /feedback-forms/{form_id}/submit',
];

/** `/mcp` uses a custom Lambda token authorizer because MCP clients cannot run
 *  the Cognito flow. Authenticated, just not by Cognito. */
const CUSTOM_AUTHORIZER_ROUTE_PREFIXES = ['/mcp'];

/** Every plugin on disk. Used to synthesize the shape a real deployment has,
 *  rather than only the empty one. */
const ALL_PLUGIN_IDS = [
  'app_reviews_android',
  'app_reviews_ios',
  's3_import',
  'synthetic_reviews',
  'webscraper',
];

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
  cachedAllPlugins ??= synthApiTemplate({}, ALL_PLUGIN_IDS);
  return cachedAllPlugins;
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
 *  `${formId}`, a literal example id, or `{form_id}`. */
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
  it('leaves only the three embeddable-widget routes unauthenticated', () => {
    expect(unauthenticatedRoutes(apiTemplate())).toEqual(INTENTIONALLY_PUBLIC_ROUTES);
  });

  it('leaves only those three unauthenticated with every plugin enabled too', () => {
    // The empty-plugin shape is not what anyone deploys. Plugin webhook
    // receivers are deliberately unauthenticated, so if a plugin ever declares
    // a webhook this fails and forces a considered allowlist entry rather than
    // shipping a new anonymous route silently. No manifest declares one today.
    expect(unauthenticatedRoutes(apiTemplateAllPlugins())).toEqual(INTENTIONALLY_PUBLIC_ROUTES);
  });

  it('pins the fact that makes the allowlist complete: no plugin declares a webhook', () => {
    // Webhook receivers are added with no method options, i.e. deliberately
    // anonymous. Today no manifest declares one, which is why the allowlist
    // above is exactly three routes. Reading the manifests directly makes that
    // assumption fail loudly the day it stops holding — the previous test
    // compares two identical shapes until then, so on its own it cannot.
    const pluginsDir = join(__dirname, '..', '..', 'plugins');
    const withWebhook = ALL_PLUGIN_IDS.filter((id) => {
      const manifest: unknown = JSON.parse(readFileSync(join(pluginsDir, id, 'manifest.json'), 'utf-8'));
      const parsed = z
        .object({ infrastructure: z.object({ webhook: z.object({ enabled: z.boolean() }).optional() }).optional() })
        .safeParse(manifest);
      return parsed.success && parsed.data.infrastructure?.webhook?.enabled === true;
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
    // `defaultMethodOptions` silently publishes everything beneath it. Matched
    // on the call expression rather than a single line, so reformatting an
    // addProxy call across lines cannot fail this falsely.
    const source = readRepoFile('lib', 'stacks', 'api-stack.ts');
    const bareProxies = [...source.matchAll(/addProxy\(/g)]
      .map((match) => source.slice(match.index ?? 0, (match.index ?? 0) + 400))
      .filter((call) => !call.includes('defaultMethodOptions'));

    expect(bareProxies).toEqual([]);
  });
});

describe('skipFeedbackFormItemRoutes (transitional upgrade flag)', () => {
  const flagged = () => synthApiTemplate({ skipFeedbackFormItemRoutes: true });

  it('omits the item routes so the old {proxy+} can be retired first', () => {
    // {form_id} cannot be created while {proxy+} still exists, and CloudFormation
    // creates before deleting, so the upgrade needs one deploy without these.
    const routes = apiMethods(flagged()).map((m) => m.route);

    expect(routes.filter((route) => route.includes('{form_id}'))).toEqual([]);
    expect(routes).toContain('GET /feedback-forms');
    expect(routes).toContain('POST /feedback-forms');
  });

  it('leaves nothing unauthenticated during that transitional deploy', () => {
    // The window is fail-closed: the public widget routes live under {form_id},
    // so they are absent too rather than exposed.
    expect(unauthenticatedRoutes(flagged())).toEqual([]);
  });

  it('is a no-op when absent — the default template keeps the item routes', () => {
    expect(unauthenticatedRoutes(apiTemplate())).toEqual(INTENTIONALLY_PUBLIC_ROUTES);
    expect(apiMethods(apiTemplate()).map((m) => m.route)).toContain('PUT /feedback-forms/{form_id}');
  });
});
