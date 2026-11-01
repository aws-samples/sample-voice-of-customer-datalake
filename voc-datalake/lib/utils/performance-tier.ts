/**
 * The performance tier: ONE opt-in that turns on every fixed-cost performance feature at once
 * (TENETS.md, tenet 7: cost-optimised by default, performance by choice).
 *
 * As a GitHub sample and proof of concept the platform runs with no fixed monthly cost: a cold
 * start is made faster, not hidden behind a paid feature. A deployment that would rather pay for
 * speed sets `-c performanceTier=true`, and every performance feature reads this flag (besides its
 * own flag) so the operator does not have to know them one by one. Today that is SnapStart on the
 * cold-start-bound API Lambdas (lib/utils/snapstart.ts); a new fixed-cost performance feature joins
 * here AND in OPT_IN_FIXED_COSTS (lib/test-support/fixed-cost-rules.ts), so the gate keeps the default clean.
 *
 * Run as a managed service, this tier would be on by default; that is a deployment's decision, so
 * the repository default stays off.
 */
import type { IConstruct } from 'constructs';
import { booleanContextFlag } from './context-flag';

/** `-c performanceTier=true` opts in; absent or false = the cost-optimised default. */
export const PERFORMANCE_TIER_CONTEXT_KEY = 'performanceTier';

/** Whether this app opted in to the performance tier. The only read of the flag. */
export function performanceTierEnabled(scope: IConstruct): boolean {
  return booleanContextFlag(
    scope.node.tryGetContext(PERFORMANCE_TIER_CONTEXT_KEY), PERFORMANCE_TIER_CONTEXT_KEY, false,
    `Use true/false (off by default: fixed monthly costs, TENETS.md tenet 7; opt in with -c ${PERFORMANCE_TIER_CONTEXT_KEY}=true).`,
  );
}
