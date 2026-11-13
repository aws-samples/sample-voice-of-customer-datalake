/**
 * VocApiStack's resource count with the engagement API (5.33.00), in the shapes that matter for
 * the 425 gate in api-stack-snapstart.test.ts (human-owned, never raised): every plugin on, with
 * and without `-c emailFrom`. The engagement release planned ≤ 20 new resources and held the
 * all-plugins synth at ≤ 420, leaving the gate's last five for whatever came next.
 *
 * 5.45.00 spent four of those five: the board authorizer is on every deployment (the board pool
 * is no longer `-c emailFrom`-only, +1 in the default shape) and the review links add `/review`
 * + `/review/{proxy+}` with ANY and two CORS preflights (+5, the authorizer's +1 already counted
 * in the emailFrom shape). One resource remains under the gate.
 *
 * 5.47.00 consolidated the routes (the 2026-10-29 route plan): CORS preflight only on method-bearing
 * resources, and proxies for /feedback, /scrapers/manual, /data-explorer, /integrations, /sources,
 * /connect and /chat, without the explicit /metrics/release-watch. 424 → 353 in both shapes; the
 * ceiling is that count + 10. api-stack-cors-preflight.test.ts pins the consolidated wiring.
 *
 * 5.63.00 (MCP OAuth sign-in, api-mcp-oauth.ts) spends 25: the Cognito resource server and three public
 * clients (4) and nine explicit anonymous routes (11 resources + 9 methods, through the existing invoke
 * permission and alias). Explicit routes rather than two proxies (14 fewer) so the anonymous surface is
 * pinned route by route. With 5.60.00's company persona routes underneath, the all-plugins synth is 384.
 * The ceiling stays 388 (the 378 + 10 set before the rebase; 384 is under it); the 425 gate is unchanged.
 *
 * 5.70.00 turned SnapStart off by default (TENETS.md, tenet 7): the default all-plugins synth drops the
 * four versions and aliases (384 → 376). The ceiling is held by the LARGEST shape, `-c snapStart=true`
 * (384, the old one), so opting in can never push the stack over it.
 *
 * 5.77.00 (API Gateway request validation, api-request-validation.ts, cdk-nag APIG2) spends 4: one
 * RequestValidator, two JSON-schema models (widget submit, ballot submit) and the BAD_REQUEST_BODY gateway
 * response. The snapStart shape was AT the 388 ceiling (388), so it moves to 392; the 425 gate is unchanged. The
 * largest shape is now `-c performanceTier=true` (SnapStart + the API's web ACL and its stage association, +2), so
 * the ceiling is 394 and that shape is checked too.
 *
 * 5.78.00: the fixture applies bin/voc-datalake.ts's whole-app rewrites (lib/utils/app-aspects.ts), so it counts
 * what deploys. That adds the one log group the aspect gives a function CDK creates without one (the website
 * BucketDeployment handler): the deployed performance-tier synth was already 395, one over the ceiling set against
 * the bare fixture. The ceiling is 395, the deployed count; the 425 gate is unchanged.
 *
 * 6.07.00 (the workspaces API, api-workspaces-lambda.ts, docs/multi-workspace.md) spends 9: its function, role,
 * default policy, log group and one invoke permission, and `/me` + `/me/{proxy+}` with GET and its CORS preflight.
 * One GET proxy rather than explicit routes, so the control plane's later `/me` reads cost nothing. Every shape
 * grows by the same 9 (performance tier 395 → 404); the ceiling is 404, and the 425 gate is unchanged.
 *
 * 6.09.00 (create and list workspaces, the platform console's API, docs/multi-workspace.md) spends 5: `/platform` +
 * `/platform/{proxy+}` with GET, POST and its CORS preflight, through the workspaces API's existing integration (no
 * new function, role or invoke permission). One proxy, so the console's later `/platform` routes cost nothing.
 * Every shape grows by the same 5 (performance tier 404 → 409); the ceiling is 409, and the 425 gate is unchanged.
 *
 * 6.10.00 (a workspace's members, docs/multi-workspace.md) spends 3: POST, PUT and DELETE on the existing
 * `/me/{proxy+}`, through the workspaces API's existing integration and CORS preflight. Under `/me` rather than a new
 * `/workspace/{proxy+}` (7: two resources, four methods, a preflight) because the routes are the members of
 * `/me/workspaces/current`, the workspace the caller acts in. Every shape grows by 3 (performance tier 409 → 412);
 * the ceiling is 412, and the 425 gate is unchanged.
 *
 * 6.18.00 (the first workspace settings, docs/multi-workspace.md, "Per-workspace configuration") spends 1: the
 * stack's one workspace-resolution policy (lib/utils/workspace-resolution-grants.ts), a customer-managed policy every
 * domain API that acts in a workspace attaches, rather than its statements and audit Denies in each role's inline
 * policy (the settings role's would pass the 70% inline-size alarm, api-stack-mcp.test.ts). One resource for the
 * whole phase: each later domain API attaches it for nothing. Every shape grows by 1 (performance tier 412 → 413);
 * the ceiling is 413, and the 425 gate is unchanged.
 * The public routes' workspace slice (docs/multi-workspace.md) spends 2 in a synth with the GitHub webhook: a
 * workspace's endpoint `/webhooks/github_issues/{ws}` (one resource, one POST, no preflight) through the webhook's
 * existing integration (no new function, role or invoke permission); the feedback forms attach the workspace-resolution
 * policy above for nothing. The ceiling is 415 (7.06.00); the 425 gate is unchanged.
 */
import { describe, expect, it } from 'vitest';

import { apiTemplateAllPlugins, discoverPluginIds, synthApiTemplate } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { SNAPSTART_CONTEXT_KEY } from '../utils/snapstart';

/**
 * The release ceiling: 388 after 5.63.00 (MCP OAuth), + 4 in 5.77.00 (request validation) + 2 for the opt-in API web
 * ACL (5.77.00) + the BucketDeployment handler's log group the bare fixture did not count (5.78.00); the
 * performance-tier synth is 395, as deployed; + 9 for the workspaces API (6.07.00): 404; + 5 for `/platform`
 * (6.09.00): 409; + 3 for the members routes' methods on `/me/{proxy+}` (6.10.00): 412; + 1 for the workspace-resolution
 * policy (6.18.00): 413; + 2 for a workspace's webhook endpoint (7.06.00): 415.
 */
const ENGAGEMENT_RELEASE_CEILING = 415;

function resourceCount(resources: Record<string, unknown> | undefined): number {
  return Object.keys(resources ?? {}).length;
}

describe('VocApiStack resource budget with the engagement API', () => {
  it('keeps every-plugin synth at or under the release ceiling', () => {
    const count = resourceCount(apiTemplateAllPlugins().toJSON().Resources);
    console.info(`VocApiStack resources, all plugins: ${count}`);
    expect(count).toBeLessThanOrEqual(ENGAGEMENT_RELEASE_CEILING);
  }, SYNTH_TIMEOUT_MS);

  it('keeps every-plugin synth with -c snapStart=true (+ a version and an alias for four functions) under it too', () => {
    const withSnapStart = synthApiTemplate({ [SNAPSTART_CONTEXT_KEY]: 'true' }, discoverPluginIds());
    const count = resourceCount(withSnapStart.toJSON().Resources);
    console.info(`VocApiStack resources, all plugins + snapStart: ${count}`);
    expect(count).toBeLessThanOrEqual(ENGAGEMENT_RELEASE_CEILING);
    expect(count - resourceCount(apiTemplateAllPlugins().toJSON().Resources)).toBe(8);
  }, SYNTH_TIMEOUT_MS * 2);

  it('keeps every-plugin synth with -c performanceTier=true (SnapStart + the API web ACL) under it too', () => {
    const tier = synthApiTemplate({ performanceTier: 'true' }, discoverPluginIds());
    const count = resourceCount(tier.toJSON().Resources);
    console.info(`VocApiStack resources, all plugins + performanceTier: ${count}`);
    expect(count).toBeLessThanOrEqual(ENGAGEMENT_RELEASE_CEILING);
  }, SYNTH_TIMEOUT_MS * 2);

  it('adds no resource with -c emailFrom (the board authorizer is on every deployment since 5.45.00)', () => {
    const withEmail = synthApiTemplate({ emailFrom: 'noreply@voc.example.com' }, discoverPluginIds());
    const count = resourceCount(withEmail.toJSON().Resources);
    console.info(`VocApiStack resources, all plugins + emailFrom: ${count}`);
    expect(count).toBe(resourceCount(apiTemplateAllPlugins().toJSON().Resources));
  }, SYNTH_TIMEOUT_MS * 2);
});
