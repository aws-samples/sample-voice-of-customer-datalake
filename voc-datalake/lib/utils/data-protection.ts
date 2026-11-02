/**
 * `protectData` — SINGLE SOURCE OF TRUTH for what happens to customer data when the stacks are deleted
 * (docs/deployment.md, "Production: protectData" and "Teardown").
 *
 * Default (on, since 5.74.00): the data tables, the raw-data bucket, the KMS key, the
 * design-integrations secret and the Cognito user pool use `RETAIN_ON_UPDATE_OR_DELETE`
 * (CloudFormation `RetainExceptOnCreate`: kept on stack deletion and on replacement, but a failed
 * FIRST create still rolls back cleanly), DynamoDB tables and the user pool get deletion protection
 * (which also blocks a console or API delete), and the raw bucket has no auto-delete provider — so
 * no rename can empty it either. Customer data is never lost to a stack delete by accident (D1, D5).
 *
 * `-c protectData=false` (demos, workshops, temporary environments): deleting the stacks is a full
 * cleanup. A teardown that should delete the data deploys with `-c protectData=false` FIRST, then
 * destroys; otherwise the retained, fixed-name resources stay and block a redeploy of the same names.
 *
 * CLI context arrives as strings; anything other than true/false throws at synth, so a typo such as
 * `-c protectData=flase` cannot silently deploy an unprotected stack.
 */
import * as cdk from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import { booleanContextFlag } from './context-flag';

const PROTECT_DATA_CONTEXT_KEY = 'protectData';

export function shouldProtectData(contextValue: unknown): boolean {
  return booleanContextFlag(
    contextValue, PROTECT_DATA_CONTEXT_KEY, true,
    `Use true/false (data is kept when the stacks are deleted by default; a demo that should delete it sets -c ${PROTECT_DATA_CONTEXT_KEY}=false).`,
  );
}

/** How the customer-data resources of one deployment are removed. */
export interface DataProtection {
  /** For tables, the raw bucket, the KMS key, the design secret and the user pool. */
  readonly removalPolicy: cdk.RemovalPolicy;
  /** DynamoDB / Cognito deletion protection; `undefined` (not rendered) when off. */
  readonly deletionProtection: true | undefined;
  /** Whether the raw bucket gets the auto-delete provider (only when data is deleted with the stack). */
  readonly autoDeleteObjects: boolean;
}

export function dataProtection(enabled: boolean): DataProtection {
  return enabled
    ? { removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE, deletionProtection: true, autoDeleteObjects: false }
    : { removalPolicy: cdk.RemovalPolicy.DESTROY, deletionProtection: undefined, autoDeleteObjects: true };
}

/** The deployment's data protection, read from the `protectData` context of `scope`'s app. */
export function dataProtectionOf(scope: IConstruct): DataProtection {
  return dataProtection(shouldProtectData(scope.node.tryGetContext(PROTECT_DATA_CONTEXT_KEY)));
}
