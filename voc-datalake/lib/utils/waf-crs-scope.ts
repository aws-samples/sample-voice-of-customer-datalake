/**
 * Where the AWS WAF Core rule set (CRS) exceptions apply (lib/utils/waf.ts, docs/deployment.md → "AWS WAF").
 *
 * The CRS rules this API legitimately trips are overridden to Count for the whole web ACL (a managed rule group
 * cannot scope an override to a path). A counting rule still LABELS the request, so one custom rule after the CRS
 * blocks a request that carries a counted rule's label on a route that has no use for the exception: the pattern in
 * https://repost.aws/knowledge-center/waf-exclude-specific-requests-inspection, with the label keys of
 * https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-baseline.html.
 *
 * The line: the exceptions exist for SIGNED-IN callers' stored text (documents, chat, imports, `?ids=` lists; the
 * Cognito and MCP-token routes) and for the MCP OAuth loopback callback. They do not apply to the UNAUTHENTICATED
 * routes, which carry small bodies: there each counted label blocks, except where a legitimate request carries it
 * (read from the handlers):
 * - `SizeRestrictions_BODY` stays counted on `POST /feedback-forms/{id}/submit`: feedback text up to 10,000
 *   characters plus 20 custom fields of 1,000 (feedback_form_handler.py), or a prototype pin up to 24,000 bytes
 *   (shared/prototype_pins.py), is over the rule's 8 KB.
 * - `/webhooks/*` keeps every body rule counted: a GitHub issue payload is over 8 KB and its body is user text with
 *   HTML, paths and URLs. The handler checks the HMAC signature before it parses anything.
 * - `GenericRFI_BODY` stays counted on `POST /oauth/register` (`redirect_uris: ["http://127.0.0.1:<port>/…"]`) and
 *   `POST /oauth/token` (the authorization-code form names the same loopback `redirect_uri`), RFC 8252.
 * - `GenericRFI_QUERYARGUMENTS` stays counted on `GET /oauth/authorize` (`redirect_uri=http://127.0.0.1:<port>/…`).
 *   `GET /oauth/callback` carries only Cognito's `code` and `state` (the loopback URI is in the relay row), so it
 *   blocks there like everywhere else.
 * - Nothing else public needs one: `/.well-known/*` and the widget's `config` / `iframe` take no body and at most a
 *   short token query (`?r=`), ballots and `POST /unsubscribe` post a few short fields, `POST /oauth/revoke` a token.
 *   Accepted edge: a widget on a page served from a bare IPv4 host sends that `page_url`, which GenericRFI_BODY blocks.
 *
 * The path WAF inspects on a REST API stage is the one the caller sent, `/<stage>/<route>` on the execute-api host
 * (there is no custom domain). The matcher takes the stage prefix as optional, so a base-path mapping that drops it
 * still matches, and it URL-decodes first, so a percent-encoded route name cannot slip past it. API Gateway resource
 * paths are case-sensitive, so a differently cased path reaches no public route. The route list below must equal
 * every unauthenticated method of the API: lib/waf-public-routes.test.ts pins it against the synthesized stack.
 */
import type * as wafv2 from 'aws-cdk-lib/aws-wafv2';

/** The CRS rules that only count on the API (see the module comment of waf.ts). */
export const API_COUNTED_CRS_RULES = [
  'SizeRestrictions_BODY', 'CrossSiteScripting_BODY', 'GenericLFI_BODY', 'GenericRFI_BODY', 'EC2MetaDataSSRF_BODY',
  'SizeRestrictions_QUERYSTRING', 'GenericRFI_QUERYARGUMENTS',
] as const;
type ApiCountedCrsRule = (typeof API_COUNTED_CRS_RULES)[number];

/** The CRS rules that only count on the SPA distribution: the OAuth consent page carries the loopback callback. */
export const CLOUDFRONT_COUNTED_CRS_RULES = ['GenericRFI_QUERYARGUMENTS'] as const;

/** The SPA's OAuth consent page (frontend/src/routes.tsx, CONSENT_PAGE_PATH in shared/mcp_oauth_config.py). */
export const SPA_OAUTH_CONSENT_PATH = '/oauth/authorize';

/** The label each counted rule adds (exact case, from the AWS baseline rule group page). */
export const CRS_RULE_LABELS: Readonly<Record<ApiCountedCrsRule, string>> = {
  SizeRestrictions_BODY: 'awswaf:managed:aws:core-rule-set:SizeRestrictions_Body',
  CrossSiteScripting_BODY: 'awswaf:managed:aws:core-rule-set:CrossSiteScripting_Body',
  GenericLFI_BODY: 'awswaf:managed:aws:core-rule-set:GenericLFI_Body',
  GenericRFI_BODY: 'awswaf:managed:aws:core-rule-set:GenericRFI_Body',
  EC2MetaDataSSRF_BODY: 'awswaf:managed:aws:core-rule-set:EC2MetaDataSSRF_Body',
  SizeRestrictions_QUERYSTRING: 'awswaf:managed:aws:core-rule-set:SizeRestrictions_QueryString',
  GenericRFI_QUERYARGUMENTS: 'awswaf:managed:aws:core-rule-set:GenericRFI_QueryArguments',
};

const BODY_RULES: readonly ApiCountedCrsRule[] = [
  'SizeRestrictions_BODY', 'CrossSiteScripting_BODY', 'GenericLFI_BODY', 'GenericRFI_BODY', 'EC2MetaDataSSRF_BODY',
];

interface PublicApiRoute {
  /** The resource path as api-routes.ts declares it (`{name}` = one path segment). */
  readonly path: string;
  /** The counted rules a legitimate request on this route trips: they stay counted here. */
  readonly keepCounted: readonly ApiCountedCrsRule[];
}

/** Every unauthenticated API path (all methods but CORS preflight), with its carve-outs (module comment). */
export const PUBLIC_API_ROUTES: readonly PublicApiRoute[] = [
  { path: '/feedback-forms/{form_id}/config', keepCounted: [] },
  { path: '/feedback-forms/{form_id}/iframe', keepCounted: [] },
  { path: '/feedback-forms/{form_id}/submit', keepCounted: ['SizeRestrictions_BODY'] },
  { path: '/voting-sessions/{session_id}/config', keepCounted: [] },
  { path: '/voting-sessions/{session_id}/submit', keepCounted: [] },
  { path: '/unsubscribe', keepCounted: [] },
  { path: '/.well-known/oauth-authorization-server', keepCounted: [] },
  { path: '/.well-known/oauth-protected-resource', keepCounted: [] },
  { path: '/.well-known/oauth-protected-resource/mcp/global', keepCounted: [] },
  { path: '/.well-known/openid-configuration', keepCounted: [] },
  { path: '/oauth/authorize', keepCounted: ['GenericRFI_QUERYARGUMENTS'] },
  { path: '/oauth/callback', keepCounted: [] },
  { path: '/oauth/register', keepCounted: ['GenericRFI_BODY'] },
  { path: '/oauth/revoke', keepCounted: [] },
  { path: '/oauth/token', keepCounted: ['GenericRFI_BODY'] },
  { path: '/webhooks/{plugin}', keepCounted: BODY_RULES },
];

/** WAF caps a RegexString at 512 characters. */
export const WAF_REGEX_MAX_CHARS = 512;

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One path segment of a template: a `{param}` matches any one segment. */
const segmentRegex = (segment: string): string => (/^\{\w+\}$/.test(segment) ? '[^/]+' : escapeRegex(segment));

/** An alternation, or the single item as it is. */
const alternation = (items: readonly string[]): string => (items.length === 1 ? items[0] ?? '' : `(?:${items.join('|')})`);

/**
 * One anchored regex for `paths`, the routes sharing a parent written once (`/oauth/(?:authorize|token)`) so the
 * whole public list stays under {@link WAF_REGEX_MAX_CHARS}. The stage prefix is optional; a trailing `/` is allowed.
 */
export function pathsRegex(paths: readonly string[], stageName: string): string {
  const byParent = new Map<string, string[]>();
  for (const path of paths) {
    const segments = path.split('/').filter(Boolean);
    const parent = segments.slice(0, -1).map(segmentRegex).join('/');
    byParent.set(parent, [...(byParent.get(parent) ?? []), segmentRegex(segments.at(-1) ?? '')]);
  }
  const branches = [...byParent].map(([parent, leaves]) => `${parent ? '/' : ''}${parent}/${alternation(leaves)}`);
  const regex = `^(?:/${escapeRegex(stageName)})?${alternation(branches)}/?$`;
  if (regex.length > WAF_REGEX_MAX_CHARS) throw new Error(`WAF path regex is ${regex.length} characters, over ${WAF_REGEX_MAX_CHARS}`);
  return regex;
}

type Statement = wafv2.CfnWebACL.StatementProperty;

/** CloudWatch metrics and sampled requests (3 hours) for a rule or an ACL; no request content is logged. */
export const visibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
  cloudWatchMetricsEnabled: true, metricName, sampledRequestsEnabled: true,
});

const labelMatch = (rule: ApiCountedCrsRule): Statement => ({
  labelMatchStatement: { scope: 'LABEL', key: CRS_RULE_LABELS[rule] },
});

/** The URI path matched against `regex` after one URL decode. */
const uriPathMatches = (regex: string): Statement => ({
  regexMatchStatement: {
    regexString: regex,
    fieldToMatch: { uriPath: {} },
    textTransformations: [{ priority: 0, type: 'URL_DECODE' }],
  },
});

/** OR of two or more statements, or the single one as it is (WAF requires two in an OR). */
const anyOf = (statements: readonly Statement[]): Statement => (
  statements.length === 1 && statements[0] ? statements[0] : { orStatement: { statements: [...statements] } }
);

/** For each counted rule, the public paths it blocks on; rules with the same paths grouped (one regex each). */
export function blockedPathGroups(): { rules: ApiCountedCrsRule[]; paths: string[] }[] {
  const groups = new Map<string, { rules: ApiCountedCrsRule[]; paths: string[] }>();
  for (const rule of API_COUNTED_CRS_RULES) {
    const paths = PUBLIC_API_ROUTES.filter((route) => !route.keepCounted.includes(rule)).map((route) => route.path);
    const key = paths.join('\n');
    const group = groups.get(key) ?? { rules: [], paths };
    group.rules.push(rule);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.paths.length > 0);
}

/** The API rule after the CRS: a counted rule's label on a public route that has no use for it blocks. */
export function apiCountedCrsScopeRule(priority: number, stageName: string): wafv2.CfnWebACL.RuleProperty {
  const name = 'BlockCountedCrsOnPublicRoutes';
  return {
    name,
    priority,
    action: { block: {} },
    statement: anyOf(blockedPathGroups().map(({ rules, paths }) => ({
      andStatement: { statements: [anyOf(rules.map(labelMatch)), uriPathMatches(pathsRegex(paths, stageName))] },
    }))),
    visibilityConfig: visibility(name),
  };
}

/** The CloudFront rule after the CRS: a loopback URL in a query blocks everywhere but the OAuth consent page. */
export function cloudFrontCountedCrsScopeRule(priority: number): wafv2.CfnWebACL.RuleProperty {
  const name = 'BlockQueryRfiOutsideOAuthConsent';
  return {
    name,
    priority,
    action: { block: {} },
    statement: {
      andStatement: {
        statements: [
          labelMatch('GenericRFI_QUERYARGUMENTS'),
          { notStatement: { statement: uriPathMatches(`^${escapeRegex(SPA_OAUTH_CONSENT_PATH)}/?$`) } },
        ],
      },
    },
    visibilityConfig: visibility(name),
  };
}
