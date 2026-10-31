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
 * 5.61.00 (MCP OAuth sign-in, api-mcp-oauth.ts) spends 25: the Cognito resource server and three public
 * clients (4) and nine explicit anonymous routes (11 resources + 9 methods, through the existing invoke
 * permission and alias). Explicit routes rather than two proxies (14 fewer) so the anonymous surface is
 * pinned route by route. The ceiling becomes 378 + 10 = 388, as above; the 425 gate is unchanged.
 */
import { describe, expect, it } from 'vitest';

import { apiTemplateAllPlugins, discoverPluginIds, synthApiTemplate } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

/** The release ceiling after 5.61.00 (MCP OAuth, 378 resources): that count + 10. */
const ENGAGEMENT_RELEASE_CEILING = 388;

function resourceCount(resources: Record<string, unknown> | undefined): number {
  return Object.keys(resources ?? {}).length;
}

describe('VocApiStack resource budget with the engagement API', () => {
  it('keeps every-plugin synth at or under the release ceiling', () => {
    const count = resourceCount(apiTemplateAllPlugins().toJSON().Resources);
    console.info(`VocApiStack resources, all plugins: ${count}`);
    expect(count).toBeLessThanOrEqual(ENGAGEMENT_RELEASE_CEILING);
  }, SYNTH_TIMEOUT_MS);

  it('adds no resource with -c emailFrom (the board authorizer is on every deployment since 5.45.00)', () => {
    const withEmail = synthApiTemplate({ emailFrom: 'noreply@voc.example.com' }, discoverPluginIds());
    const count = resourceCount(withEmail.toJSON().Resources);
    console.info(`VocApiStack resources, all plugins + emailFrom: ${count}`);
    expect(count).toBe(resourceCount(apiTemplateAllPlugins().toJSON().Resources));
  }, SYNTH_TIMEOUT_MS * 2);
});
