/**
 * The rule that scopes the CRS rules the web ACLs count (lib/utils/waf-crs-scope.ts) to the routes that need them.
 *
 * - its exact shape on each ACL;
 * - LOCKSTEP with the API: in the all-plugins synth with the WAF opt-in on, every method without an authorizer (CORS
 *   preflight aside) is a path the rule blocks the counted labels on, and no Cognito- or token-authorized one is,
 *   evaluated from the synthesized statement itself, so a new public route cannot keep the exceptions by accident;
 * - the carve-outs a legitimate public request needs, and the capacity (WCU) of both ACLs.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  INTENTIONALLY_PUBLIC_OAUTH_ROUTES, INTENTIONALLY_PUBLIC_ROUTES, INTENTIONALLY_PUBLIC_WEBHOOK_ROUTES,
  discoverPluginIds, nonOptions, synthApiTemplate,
} from './test-support/api-stack-template';
import { byCodeUnit } from './utils/compare';
import { createCloudFrontWebAcl } from './utils/waf';
import {
  API_COUNTED_CRS_RULES, CRS_RULE_LABELS, PUBLIC_API_ROUTES, WAF_REGEX_MAX_CHARS, cloudFrontCountedCrsScopeRule,
  pathsRegex,
} from './utils/waf-crs-scope';

const STAGE = 'v1';
/** A `{param}` in the decoded path: one or more segments (waf-crs-scope.ts segmentRegex). */
const PARAM = '[^/]+(?:/[^/]+)*';
/** The two public submit routes (customers' free text) and the webhooks keep the content body rules counted. */
const SUBMITS_AND_WEBHOOKS = ['/feedback-forms/{form_id}/submit', '/voting-sessions/{session_id}/submit', '/webhooks/{plugin}'];
const LABEL = (rule: keyof typeof CRS_RULE_LABELS) => ({ LabelMatchStatement: { Scope: 'LABEL', Key: CRS_RULE_LABELS[rule] } });
const PATH = (regex: string) => ({
  RegexMatchStatement: { RegexString: regex, FieldToMatch: { UriPath: {} }, TextTransformations: [{ Priority: 0, Type: 'URL_DECODE' }] },
});

const WAF_ON = synthApiTemplate({ enableWaf: 'true' }, discoverPluginIds());

// ── A small evaluator over the synthesized statement ────────────────────────
interface Request { path: string; labels: ReadonlySet<string> }
const StatementSchema: z.ZodType<Statement> = z.lazy(() => z.union([
  z.object({ OrStatement: z.object({ Statements: z.array(StatementSchema) }) }),
  z.object({ AndStatement: z.object({ Statements: z.array(StatementSchema) }) }),
  z.object({ NotStatement: z.object({ Statement: StatementSchema }) }),
  z.object({ LabelMatchStatement: z.object({ Scope: z.literal('LABEL'), Key: z.string() }) }),
  z.object({ RegexMatchStatement: z.object({
    RegexString: z.string(), FieldToMatch: z.object({ UriPath: z.object({}) }),
    TextTransformations: z.array(z.object({ Priority: z.number(), Type: z.literal('URL_DECODE') })).length(1),
  }) }),
]));
type Statement =
  | { OrStatement: { Statements: Statement[] } }
  | { AndStatement: { Statements: Statement[] } }
  | { NotStatement: { Statement: Statement } }
  | { LabelMatchStatement: { Scope: 'LABEL'; Key: string } }
  | { RegexMatchStatement: {
    RegexString: string; FieldToMatch: { UriPath: object }; TextTransformations: { Priority: number; Type: 'URL_DECODE' }[];
  } };

function matches(statement: Statement, request: Request): boolean {
  if ('OrStatement' in statement) return statement.OrStatement.Statements.some((child) => matches(child, request));
  if ('AndStatement' in statement) return statement.AndStatement.Statements.every((child) => matches(child, request));
  if ('NotStatement' in statement) return !matches(statement.NotStatement.Statement, request);
  if ('LabelMatchStatement' in statement) return request.labels.has(statement.LabelMatchStatement.Key);
  return new RegExp(statement.RegexMatchStatement.RegexString).test(decodeURIComponent(request.path));
}

/** WCU as AWS prices them: 1 per label match, 3 per regex match + 10 per text transformation; logic adds none. */
function wcu(statement: unknown): number {
  const parsed = StatementSchema.parse(statement);
  if ('OrStatement' in parsed) return parsed.OrStatement.Statements.reduce((sum, child) => sum + wcu(child), 0);
  if ('AndStatement' in parsed) return parsed.AndStatement.Statements.reduce((sum, child) => sum + wcu(child), 0);
  if ('NotStatement' in parsed) return wcu(parsed.NotStatement.Statement);
  if ('LabelMatchStatement' in parsed) return 1;
  return 3 + 10;
}

const AclSchema = z.object({ Rules: z.array(z.object({ Name: z.string(), Statement: z.unknown() })) });
function scopeStatement(template: Template, ruleName: string): Statement {
  const [acl] = Object.values(template.findResources('AWS::WAFv2::WebACL'));
  const rule = AclSchema.parse(acl?.Properties).Rules.find((candidate) => candidate.Name === ruleName);
  return StatementSchema.parse(rule?.Statement);
}

/**
 * A method path as a caller sends it: the stage first (unless `withStage` is false), every `{param}` filled in, a
 * greedy `{proxy+}` with two segments (a deeper path than one segment is what a proxy route actually receives).
 */
function requestPath(template: string, withStage = true): string {
  const fill = (segment: string): string => {
    if (segment.endsWith('+}')) return 'deep/er';
    return segment.startsWith('{') ? 'sample_id-1' : segment;
  };
  const filled = template.split('/').map(fill).join('/');
  return withStage ? `/${STAGE}${filled}` : filled;
}
const blocksLabel = (statement: Statement, path: string, rule: keyof typeof CRS_RULE_LABELS) =>
  matches(statement, { path, labels: new Set([CRS_RULE_LABELS[rule]]) });

// ── The API ACL ─────────────────────────────────────────────────────────────
describe('the API scope rule (BlockCountedCrsOnPublicRoutes)', () => {
  const statement = scopeStatement(WAF_ON, 'BlockCountedCrsOnPublicRoutes');
  const methods = nonOptions(WAF_ON);
  const publicPaths = [...new Set(methods.filter((m) => m.authorizationType === 'NONE').map((m) => m.path))].sort(byCodeUnit);
  const protectedPaths = [...new Set(methods.filter((m) => m.authorizationType !== 'NONE').map((m) => m.path))]
    .filter((path) => !publicPaths.includes(path));

  it('has this exact shape: one AND (labels, URL-decoded path regex) per group of rules sharing their blocked paths', () => {
    const regex = (exclude: string[]) => pathsRegex(PUBLIC_API_ROUTES.map((r) => r.path).filter((p) => !exclude.includes(p)), STAGE);
    const and = (labels: object, path: object) => ({ AndStatement: { Statements: [labels, path] } });
    expect(statement).toStrictEqual({ OrStatement: { Statements: [
      and(LABEL('SizeRestrictions_BODY'), PATH(regex(['/feedback-forms/{form_id}/submit', '/webhooks/{plugin}']))),
      and({ OrStatement: { Statements: [LABEL('CrossSiteScripting_BODY'), LABEL('GenericLFI_BODY'), LABEL('EC2MetaDataSSRF_BODY')] } },
        PATH(regex(SUBMITS_AND_WEBHOOKS))),
      and(LABEL('GenericRFI_BODY'), PATH(regex(['/oauth/register', '/oauth/token', ...SUBMITS_AND_WEBHOOKS]))),
      and(LABEL('SizeRestrictions_QUERYSTRING'), PATH(regex([]))),
      and(LABEL('GenericRFI_QUERYARGUMENTS'), PATH(regex(['/oauth/authorize']))),
    ] } });
    expect(PATH(regex([])).RegexMatchStatement.RegexString).toBe(
      `^(?:/v1)?(?:/feedback-forms/${PARAM}/(?:config|iframe|submit)|/voting-sessions/${PARAM}/(?:config|submit)|/unsubscribe`
      + '|/\\.well-known/(?:oauth-authorization-server|oauth-protected-resource|openid-configuration)'
      + '|/\\.well-known/oauth-protected-resource/mcp/global|/oauth/(?:authorize|callback|register|revoke|token)'
      + `|/webhooks/${PARAM})/?$`);
  });

  it('lists exactly the routes the API publishes (the review-gate lists of api-stack-template.ts)', () => {
    const gated = [...INTENTIONALLY_PUBLIC_ROUTES, ...INTENTIONALLY_PUBLIC_OAUTH_ROUTES, ...INTENTIONALLY_PUBLIC_WEBHOOK_ROUTES]
      .map((route) => route.split(' ')[1] ?? '');
    const covered = (path: string) => PUBLIC_API_ROUTES.some((route) => new RegExp(pathsRegex([route.path], STAGE)).test(path));
    expect([...new Set(gated)].filter((path) => !covered(path))).toStrictEqual([]);
    const stale = PUBLIC_API_ROUTES.filter((route) => !publicPaths.some((path) => new RegExp(pathsRegex([route.path], STAGE)).test(path)));
    expect(stale).toStrictEqual([]);
    expect(publicPaths.length).toBeGreaterThanOrEqual(16);
  });

  it('LOCKSTEP: every unauthenticated method path blocks a counted label (with or without the stage prefix)', () => {
    const missed = publicPaths.filter((path) => !blocksLabel(statement, requestPath(path), 'SizeRestrictions_QUERYSTRING')
      || !blocksLabel(statement, requestPath(path, false), 'SizeRestrictions_QUERYSTRING'));
    expect(missed).toStrictEqual([]);
  });

  it('LOCKSTEP: no Cognito- or token-authorized path is matched, for any counted label', () => {
    // Vacuity floor: 44 resource paths carry an authorizer today (most domains sit behind one `{proxy+}`).
    expect(protectedPaths.length).toBeGreaterThan(40);
    const wronglyBlocked = protectedPaths.filter((path) => API_COUNTED_CRS_RULES.some((rule) => blocksLabel(statement, requestPath(path), rule)));
    expect(wronglyBlocked).toStrictEqual([]);
  });

  it.each([
    ['/feedback-forms/{form_id}/submit', 'SizeRestrictions_BODY', false],
    // A customer's own words: HTML, `../`, a link to an IPv4 host or the metadata address is feedback here.
    ['/feedback-forms/{form_id}/submit', 'CrossSiteScripting_BODY', false],
    ['/feedback-forms/{form_id}/submit', 'GenericLFI_BODY', false],
    ['/feedback-forms/{form_id}/submit', 'GenericRFI_BODY', false],
    ['/feedback-forms/{form_id}/submit', 'EC2MetaDataSSRF_BODY', false],
    ['/feedback-forms/{form_id}/submit', 'SizeRestrictions_QUERYSTRING', true],
    ['/feedback-forms/{form_id}/config', 'SizeRestrictions_BODY', true],
    ['/webhooks/github_issues', 'SizeRestrictions_BODY', false],
    ['/webhooks/github_issues', 'CrossSiteScripting_BODY', false],
    ['/webhooks/github_issues', 'GenericRFI_BODY', false],
    ['/webhooks/github_issues', 'SizeRestrictions_QUERYSTRING', true],
    ['/oauth/authorize', 'GenericRFI_QUERYARGUMENTS', false],
    ['/oauth/callback', 'GenericRFI_QUERYARGUMENTS', true],
    ['/oauth/register', 'GenericRFI_BODY', false],
    ['/oauth/token', 'GenericRFI_BODY', false],
    ['/oauth/token', 'SizeRestrictions_BODY', true],
    ['/oauth/revoke', 'GenericRFI_BODY', true],
    ['/.well-known/openid-configuration', 'GenericRFI_QUERYARGUMENTS', true],
    ['/unsubscribe', 'GenericLFI_BODY', true],
    ['/voting-sessions/{session_id}/submit', 'EC2MetaDataSSRF_BODY', false],
    ['/voting-sessions/{session_id}/submit', 'CrossSiteScripting_BODY', false],
    ['/voting-sessions/{session_id}/submit', 'SizeRestrictions_BODY', true],
    ['/voting-sessions/{session_id}/config', 'CrossSiteScripting_BODY', true],
  ] as const)('%s with %s: blocked=%s', (path, rule, blocked) => {
    expect(blocksLabel(statement, requestPath(path), rule)).toBe(blocked);
  });

  it('blocks a percent-encoded route name too, and nothing without a counted label', () => {
    expect(blocksLabel(statement, '/v1/unsubscrib%65', 'GenericLFI_BODY')).toBe(true);
    // API Gateway routes `a%2Fb` to one {form_id}; after the URL decode it is two segments, still matched.
    expect(blocksLabel(statement, '/v1/feedback-forms/a%2Fb/config', 'CrossSiteScripting_BODY')).toBe(true);
    expect(blocksLabel(statement, '/v1/voting-sessions/a%2Fb%2Fc/submit', 'SizeRestrictions_BODY')).toBe(true);
    expect(matches(statement, { path: '/v1/unsubscribe', labels: new Set() })).toBe(false);
  });

  it('costs 72 WCU, so the API ACL needs 999 of the 1,500 a web ACL includes', () => {
    expect(wcu(statement)).toBe(72);
    expect(25 + 2 + 200 + 700 + wcu(statement)).toBe(999);
  });

  it('keeps every regex under the WAF limit, and refuses one over it', () => {
    expect(pathsRegex(PUBLIC_API_ROUTES.map((route) => route.path), STAGE).length).toBeLessThanOrEqual(WAF_REGEX_MAX_CHARS);
    expect(() => pathsRegex(Array.from({ length: 40 }, (_, i) => `/route-number-${i}/x`), STAGE)).toThrow(/over 512/);
  });
});

// ── The CloudFront ACL ──────────────────────────────────────────────────────
describe('the CloudFront scope rule (BlockQueryRfiOutsideOAuthConsent)', () => {
  const stack = new cdk.Stack(new cdk.App(), 'Edge', { env: { account: '111111111111', region: 'us-east-1' } });
  createCloudFrontWebAcl(stack);
  const statement = scopeStatement(Template.fromStack(stack), 'BlockQueryRfiOutsideOAuthConsent');
  const rfiQuery = (path: string) => matches(statement, { path, labels: new Set([CRS_RULE_LABELS.GenericRFI_QUERYARGUMENTS]) });

  it('has this exact shape: the query RFI label, on any path but the SPA consent page', () => {
    expect(statement).toStrictEqual({ AndStatement: { Statements: [
      LABEL('GenericRFI_QUERYARGUMENTS'), { NotStatement: { Statement: PATH('^/oauth/authorize/?$') } },
    ] } });
    expect(cloudFrontCountedCrsScopeRule(4)).toMatchObject({ name: 'BlockQueryRfiOutsideOAuthConsent', priority: 4, action: { block: {} } });
  });

  it('lets the loopback query through on the consent page only', () => {
    expect([rfiQuery('/oauth/authorize'), rfiQuery('/oauth/authorize/')]).toStrictEqual([false, false]);
    expect([rfiQuery('/'), rfiQuery('/projects'), rfiQuery('/prototypes/x/index.html'), rfiQuery('/oauth/authorize/x')])
      .toStrictEqual([true, true, true, true]);
    expect(matches(statement, { path: '/projects', labels: new Set() })).toBe(false);
  });

  it('costs 14 WCU, so the CloudFront ACL needs 941 of the 1,500 a web ACL includes', () => {
    expect(25 + 2 + 200 + 700 + wcu(statement)).toBe(941);
  });
});
