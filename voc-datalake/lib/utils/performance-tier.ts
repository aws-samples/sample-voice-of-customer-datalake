/**
 * The performance tier: ONE opt-in that turns on every paid optimisation at once (TENETS.md, tenet 7:
 * cost-optimised by default, performance by choice). Despite the name it now covers the paid SECURITY features
 * too; the flag keeps its name so existing deployments and docs keep working.
 *
 * As a GitHub sample and proof of concept the platform runs with no fixed monthly cost: a cold
 * start is made faster, not hidden behind a paid feature. A deployment that would rather pay sets
 * `-c performanceTier=true`, and every such feature reads this flag (besides its own flag) so the
 * operator does not have to know them one by one:
 * - SnapStart on the cold-start-bound API Lambdas (`-c snapStart=true`, lib/utils/snapstart.ts) — fixed cost;
 * - AWS WAF on the SPA distribution and the API stage (`-c enableWaf=true`, lib/utils/waf.ts) — fixed cost;
 * - the Cognito Plus plan with threat protection on both user pools (`-c cognitoPlus=true`,
 *   lib/utils/cognito-plus.ts) — per active user, no fixed cost.
 * A new fixed-cost feature joins here AND in OPT_IN_FIXED_COSTS (lib/test-support/fixed-cost-rules.ts), so the gate
 * keeps the default clean.
 *
 * Run as a managed service, this tier would be on by default; that is a deployment's decision, so
 * the repository default stays off.
 */
import type { IConstruct } from 'constructs';
import { booleanContextFlag } from './context-flag';

/** `-c performanceTier=true` opts in; absent or false = the cost-optimised default. */
export const PERFORMANCE_TIER_CONTEXT_KEY = 'performanceTier';

/** Whether this app opted in to the performance tier. The only read of the flag. */
function performanceTierEnabled(scope: IConstruct): boolean {
  return booleanContextFlag(
    scope.node.tryGetContext(PERFORMANCE_TIER_CONTEXT_KEY), PERFORMANCE_TIER_CONTEXT_KEY, false,
    `Use true/false (off by default: fixed monthly costs, TENETS.md tenet 7; opt in with -c ${PERFORMANCE_TIER_CONTEXT_KEY}=true).`,
  );
}

/**
 * A feature in the tier with its own flag too: its own flag decides when it is set (`-c <key>=true` or `=false`, so a
 * tier deployment can leave one feature out), else the performance tier does. Both flags are read before they are
 * combined, so a typo in either is refused even when the other decides.
 */
export function enabledByOwnFlagOrTier(scope: IConstruct, key: string, why: string): boolean {
  const raw: unknown = scope.node.tryGetContext(key);
  const usage = `Use true/false (off by default: ${why}; opt in with -c ${key}=true, or leave it out of the tier with -c ${key}=false).`;
  const own = booleanContextFlag(raw, key, false, usage);
  const tier = performanceTierEnabled(scope);
  return raw === undefined || raw === null ? tier : own;
}
