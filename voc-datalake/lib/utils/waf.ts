/**
 * AWS WAF in front of the SPA's CloudFront distribution and the REST API stage: OFF BY DEFAULT.
 *
 * A web ACL is a FIXED monthly cost (AWS WAF pricing, https://aws.amazon.com/waf/pricing/: $5.00 per web ACL and
 * $1.00 per rule or managed rule group per month, prorated hourly, plus $0.60 per million requests), and the platform
 * runs with no fixed monthly cost by default (TENETS.md, tenet 7). `-c enableWaf=true` turns it on, and so does the
 * one-switch opt-in `-c performanceTier=true` (lib/utils/performance-tier.ts). {@link wafEnabled} is the ONLY read of
 * the flag. Each ACL below holds four billed rules (three AWS managed rule groups and one rate-based rule): about $9 a
 * month per ACL, $18 for the two, plus the request charge (docs/deployment.md → "AWS WAF (opt-in)").
 *
 * Where each ACL lives:
 * - CloudFront: a CLOUDFRONT-scope ACL must be created in us-east-1, so it lives in VocWebSearchStack (pinned to
 *   us-east-1, the app's only stack there; the app is capped at five stacks). VocCoreStack's distribution reads its
 *   ARN through the same CDK cross-region reference VocProcessingStack / VocApiStack already use for the web-search
 *   gateway (plain CloudFormation exports when the app region is us-east-1, SSM-backed otherwise).
 * - API: a REGIONAL ACL in VocApiStack, associated with the `v1` stage. The stage's per-method throttles stay as
 *   they are; the rate-based rule is a per-IP backstop above them.
 *
 * Rules (AWS Managed Rules, https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html):
 * the Amazon IP reputation list, a per-IP rate limit, Known bad inputs and the Core rule set (CRS). On the API three CRS
 * body rules and one query-string rule only COUNT, because this API legitimately carries what they block:
 * SizeRestrictions_QUERYSTRING blocks a query string over 2 KB (`GET /projects?ids=` takes up to 200 project ids,
 * Prioritization's one-call read), SizeRestrictions_BODY blocks a body over 8 KB (CSV / JSON imports,
 * conversation saves up to ~350 KB, documents, the assistant's RunAgentInput), and
 * CrossSiteScripting_BODY matches HTML in a body (documents, prototypes, pasted reviews and assistant answers are
 * stored text; the SPA escapes them when it renders). Every other CRS rule blocks. No logging configuration: WAF keeps
 * only its CloudWatch metrics and sampled requests (3 hours), so no request content is stored.
 */
import * as cdk from 'aws-cdk-lib';
import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { IConstruct } from 'constructs';
import { PERFORMANCE_TIER_CONTEXT_KEY, enabledByOwnFlagOrTier } from './performance-tier';

/** `-c enableWaf=true` opts in; absent or false = no web ACL anywhere. */
export const WAF_CONTEXT_KEY = 'enableWaf';

/** What the acknowledgement of a WAF rule says while the opt-in is off. */
export const WAF_OPT_IN_HINT = `opt-in: -c ${WAF_CONTEXT_KEY}=true / ${PERFORMANCE_TIER_CONTEXT_KEY}`;

/** A web ACL description allows only letters, digits, spaces and `+=:#@/-,.` (no parentheses). */
const WAF_DESCRIPTION_SUFFIX = `opt-in -c ${WAF_CONTEXT_KEY}=true or ${PERFORMANCE_TIER_CONTEXT_KEY}=true`;

/** Requests per IP per 5 minutes before the rate-based rule blocks (well above one person's use of the SPA). */
export const WAF_RATE_LIMIT_PER_5_MIN = { cloudFront: 10_000, api: 5_000 } as const;

/** The CRS rules that only count on the API (see the module comment). */
export const API_COUNTED_CRS_RULES = ['SizeRestrictions_BODY', 'CrossSiteScripting_BODY', 'SizeRestrictions_QUERYSTRING'] as const;

/** Whether this app opted in to AWS WAF: `-c enableWaf=true` or the performance tier. */
export function wafEnabled(scope: IConstruct): boolean {
  return enabledByOwnFlagOrTier(scope, WAF_CONTEXT_KEY, 'a fixed monthly cost, TENETS.md tenet 7');
}

const visibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
  cloudWatchMetricsEnabled: true, metricName, sampledRequestsEnabled: true,
});

function managedRuleGroup(
  name: string, priority: number, countedRules: readonly string[] = [],
): wafv2.CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    overrideAction: { none: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name,
        ...(countedRules.length > 0
          ? { ruleActionOverrides: countedRules.map((rule) => ({ name: rule, actionToUse: { count: {} } })) }
          : {}),
      },
    },
    visibilityConfig: visibility(name),
  };
}

interface WebAclOptions {
  readonly scope: 'CLOUDFRONT' | 'REGIONAL';
  readonly description: string;
  readonly ratePer5Min: number;
  readonly countedCrsRules?: readonly string[];
}

/** One web ACL: allow by default; IP reputation, a per-IP rate limit, Known bad inputs and the CRS block. */
function createWebAcl(scope: IConstruct, id: string, options: WebAclOptions): wafv2.CfnWebACL {
  // No Name: CloudFormation generates a unique one, so a prefixed second deployment never collides.
  return new wafv2.CfnWebACL(scope, id, {
    scope: options.scope,
    description: options.description,
    defaultAction: { allow: {} },
    visibilityConfig: visibility(id),
    rules: [
      managedRuleGroup('AWSManagedRulesAmazonIpReputationList', 0),
      {
        name: 'RateLimitPerIp',
        priority: 1,
        action: { block: {} },
        statement: {
          rateBasedStatement: { limit: options.ratePer5Min, aggregateKeyType: 'IP', evaluationWindowSec: 300 },
        },
        visibilityConfig: visibility('RateLimitPerIp'),
      },
      managedRuleGroup('AWSManagedRulesKnownBadInputsRuleSet', 2),
      managedRuleGroup('AWSManagedRulesCommonRuleSet', 3, options.countedCrsRules),
    ],
  });
}

/** The CLOUDFRONT-scope ACL for the SPA distribution; `stack` must be in us-east-1 (VocWebSearchStack). */
export function createCloudFrontWebAcl(stack: cdk.Stack): wafv2.CfnWebACL {
  if (!cdk.Token.isUnresolved(stack.region) && stack.region !== 'us-east-1') {
    throw new Error(`A CLOUDFRONT-scope web ACL must be created in us-east-1, not ${stack.region}`);
  }
  return createWebAcl(stack, 'FrontendWebAcl', {
    scope: 'CLOUDFRONT',
    description: `VoC SPA CloudFront distribution, ${WAF_DESCRIPTION_SUFFIX}`,
    ratePer5Min: WAF_RATE_LIMIT_PER_5_MIN.cloudFront,
  });
}

/** The REGIONAL ACL on the REST API's deployment stage. */
export function protectApiStage(stack: cdk.Stack, api: apigateway.RestApi): wafv2.CfnWebACL {
  const webAcl = createWebAcl(stack, 'ApiWebAcl', {
    scope: 'REGIONAL',
    description: `VoC REST API stage, ${WAF_DESCRIPTION_SUFFIX}`,
    ratePer5Min: WAF_RATE_LIMIT_PER_5_MIN.api,
    countedCrsRules: API_COUNTED_CRS_RULES,
  });
  new wafv2.CfnWebACLAssociation(stack, 'ApiWebAclAssociation', {
    resourceArn: api.deploymentStage.stageArn,
    webAclArn: webAcl.attrArn,
  });
  return webAcl;
}
