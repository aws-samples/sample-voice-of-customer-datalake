/**
 * Where Bedrock inference may run (docs/eu-deployment.md).
 *
 *   -c inferenceScope=global   (default) `global.` cross-region inference profiles —
 *                              requests may be served in any commercial region.
 *   -c inferenceScope=eu       `eu.` profiles — requests stay inside EU regions.
 *
 * Stored and allowlisted model ids stay CANONICAL (`global.…`) everywhere: the
 * picker, the settings row, lockstep tests, the stream allowlist. The scope is
 * applied at CALL time — `BEDROCK_INFERENCE_SCOPE=eu` on every Lambda makes
 * shared/model_config.py and the stream Lambda swap the prefix — and here, where
 * the IAM grants are built (eu → the `eu.` profile ARNs only, so a `global.` call
 * from an EU deployment is an AccessDenied rather than a silent residency breach).
 *
 * Read from CDK context (like `defaultModelId`) rather than threaded as a prop:
 * every grant site and the stack-wide env aspect need it, and the context is the
 * one value every construct of the app already shares. Unknown values throw.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { IConstruct } from 'constructs';

const INFERENCE_SCOPES = ['global', 'eu'] as const;
export type InferenceScope = (typeof INFERENCE_SCOPES)[number];

const INFERENCE_SCOPE_CONTEXT_KEY = 'inferenceScope';

function isInferenceScope(value: unknown): value is InferenceScope {
  return INFERENCE_SCOPES.some((scope) => scope === value);
}

/** Validate a raw context value. Absent/empty → `global`; anything else unknown throws. */
export function parseInferenceScope(raw: unknown): InferenceScope {
  if (raw === undefined || raw === null || raw === '') return 'global';
  if (isInferenceScope(raw)) return raw;
  throw new Error(
    `Invalid -c ${INFERENCE_SCOPE_CONTEXT_KEY}=${JSON.stringify(raw)}: expected one of ${INFERENCE_SCOPES.join(', ')}.`,
  );
}

/** The scope in force for `scope`'s app. */
export function inferenceScopeOf(scope: IConstruct): InferenceScope {
  return parseInferenceScope(scope.node.tryGetContext(INFERENCE_SCOPE_CONTEXT_KEY));
}

/**
 * Environment every Lambda of an EU deployment gets:
 *  - BEDROCK_INFERENCE_SCOPE=eu — call-time `global.` → `eu.` mapping;
 *  - AVATARS_ENABLED=false — the persona avatar image model only runs in
 *    us-west-2, so avatars degrade to none instead of leaving the EU.
 * Empty for `global`, so a default deployment's templates do not change.
 */
export function inferenceScopeEnv(scope: InferenceScope): Readonly<Record<string, string>> {
  return scope === 'eu' ? { BEDROCK_INFERENCE_SCOPE: 'eu', AVATARS_ENABLED: 'false' } : {};
}

/**
 * Adds {@link inferenceScopeEnv} to every Lambda function (Python and Node) in
 * the stacks it is applied to. Every function rather than a hand-kept list of
 * Bedrock callers: a missed caller would quietly keep calling `global.` (and be
 * AccessDenied); an extra variable on a function that never calls Bedrock costs
 * nothing.
 */
class InferenceScopeEnvAspect implements cdk.IAspect {
  constructor(private readonly env: Readonly<Record<string, string>>) {}

  visit(node: IConstruct): void {
    if (!(node instanceof lambda.Function)) return;
    for (const [key, value] of Object.entries(this.env)) {
      node.addEnvironment(key, value);
    }
  }
}

/** Apply the scope's env to every function under `scope` (no-op for `global`). */
export function applyInferenceScopeEnv(scope: IConstruct): void {
  const env = inferenceScopeEnv(inferenceScopeOf(scope));
  if (Object.keys(env).length === 0) return;
  cdk.Aspects.of(scope).add(new InferenceScopeEnvAspect(env));
}
