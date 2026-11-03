/**
 * The whole-app rewrites of the deployed templates, in one place: bin/voc-datalake.ts applies them to the app
 * once every stack is built, and every per-stack test fixture (lib/test-support/*-fixture.ts,
 * api-stack-template.ts) applies them to its own app, so a per-stack test asserts the template that deploys.
 *
 * In this order (registration order is the order the aspects visit a construct in):
 *
 *   1. every Lambda logs to its own retained log group and its role writes only that group (log-retention.ts);
 *   2. `protectData` (on unless `-c protectData=false`): every log group is retained on stack deletion;
 *   3. `-c inferenceScope=eu`: the EU inference env on every Lambda (inference-scope.ts; a no-op for `global`);
 *   4. CDK grant wildcards become the exact actions and index ARNs (exact-grants.ts). Not an aspect: it wraps
 *      the policies that exist when it is called, so call this once, after every stack is built.
 *
 * Both switches are read from the scope's context, like bin/ reads them. The cdk-nag plugin and the reviewed
 * acknowledgements (bin/voc-datalake.ts) are NOT here: they judge the template rather than shape it, and the
 * fixtures' nag cases run without them on purpose, so that every rule can still fail there.
 */
import type { IConstruct } from 'constructs';
import { shouldProtectData } from './data-protection';
import { applyExactGrants } from './exact-grants';
import { applyInferenceScopeEnv } from './inference-scope';
import { applyLambdaLogRetention, applyProtectedLogRetention } from './log-retention';

/** Apply every whole-app rewrite to `scope` (an app, or a fixture's stack): see the module comment. */
export function applyAppAspects(scope: IConstruct): void {
  applyLambdaLogRetention(scope);
  applyProtectedLogRetention(scope, shouldProtectData(scope.node.tryGetContext('protectData')));
  applyInferenceScopeEnv(scope);
  applyExactGrants(scope);
}
