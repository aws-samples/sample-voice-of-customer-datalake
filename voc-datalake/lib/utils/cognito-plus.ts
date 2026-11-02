/**
 * The Cognito Plus feature plan (threat protection) on both user pools: OFF BY DEFAULT.
 *
 * Plus is billed per monthly active user with no free tier: $0.020 per MAU, against Essentials' $0.015 per MAU
 * above 10,000 free MAUs (https://aws.amazon.com/cognito/pricing/). It is usage-based, not a fixed monthly cost, but
 * it raises every active user's price, so it is the deployment's choice: `-c cognitoPlus=true`, or the one-switch
 * opt-in `-c performanceTier=true` (lib/utils/performance-tier.ts). {@link cognitoPlusEnabled} is the ONLY read of
 * the flag.
 *
 * With it on, threat protection (compromised-credential detection and adaptive authentication) runs in AUDIT mode:
 * Cognito scores every sign-in and records the risk, but takes no action, so it cannot lock anyone out. AWS
 * recommends starting in audit-only mode and reviewing the events before enforcing
 * (https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-threat-protection.html).
 * Plus includes every Essentials feature, so passkeys (app pool) and email OTP (board pool) keep working.
 */
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { IConstruct } from 'constructs';
import { PERFORMANCE_TIER_CONTEXT_KEY, enabledByOwnFlagOrTier } from './performance-tier';

/** `-c cognitoPlus=true` opts in; absent or false = Essentials. */
const COGNITO_PLUS_CONTEXT_KEY = 'cognitoPlus';

/** What the COG8 acknowledgement says while the opt-in is off. */
export const COGNITO_PLUS_OPT_IN_HINT = `opt-in: -c ${COGNITO_PLUS_CONTEXT_KEY}=true / ${PERFORMANCE_TIER_CONTEXT_KEY}`;

/** Whether this app opted in to Cognito Plus: `-c cognitoPlus=true` or the performance tier. */
export function cognitoPlusEnabled(scope: IConstruct): boolean {
  return enabledByOwnFlagOrTier(scope, COGNITO_PLUS_CONTEXT_KEY, 'a per-active-user charge');
}

/** The feature plan (and, on Plus, the threat-protection mode) a user pool is created with. */
export function userPoolFeaturePlan(
  scope: IConstruct,
): Pick<cognito.UserPoolProps, 'featurePlan' | 'standardThreatProtectionMode'> {
  return cognitoPlusEnabled(scope)
    ? { featurePlan: cognito.FeaturePlan.PLUS, standardThreatProtectionMode: cognito.StandardThreatProtectionMode.AUDIT_ONLY }
    : { featurePlan: cognito.FeaturePlan.ESSENTIALS };
}
