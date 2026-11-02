/**
 * The `bedrock:InvokeModel*` grant on every allowlisted Claude model, in the three-part shape AWS documents for
 * cross-Region inference, with no Region wildcard:
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html  (global, default)
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html (`-c inferenceScope=eu`)
 *
 *  1. `ClaudeProfiles`: the inference profiles in the app region (the `modelId` every caller sends). No condition:
 *     Bedrock does not populate `bedrock:InferenceProfileArn` on the profile evaluation.
 *  2. `ClaudeRegionalModels`: the foundation models in the app region (global) or in every destination Region of
 *     the `eu.` profiles (eu, model-allowlist.ts EU_PROFILE_DESTINATION_REGIONS), only through one of those profiles.
 *  3. `ClaudeGlobalModels` (global only): the Region-agnostic `arn:…:bedrock:::foundation-model/<model>`, for which
 *     Bedrock sets `aws:RequestedRegion` to `unspecified`, again only through one of the profiles.
 * The docs' example also puts `aws:RequestedRegion` = the app region on parts 1 and 2; both ARNs already name that
 * region, so the condition adds nothing and is left out (policy size).
 *
 * The statements live in customer-managed policies SHARED by every Bedrock role of a stack (one set per action
 * variant), not in each role's inline policy: three parts per model on ~23 roles would push the largest inline
 * policies (Settings ~5.6 KB of 10,240) past the 70% guard in api-stack-mcp.test.ts. Each managed policy carries
 * {@link MODELS_PER_POLICY} models so it stays under 70% of the 6,144-character managed quota in both scopes
 * (an eu policy lists 6–7 destination Regions per model).
 *
 * The image model and the Titan embedder are in-Region models invoked directly; their exact ARNs stay in the
 * callers' own statements (model-allowlist.ts imageModelArn / embeddingModelArn).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IConstruct } from 'constructs';

import { type ClaudeModelArns, stackModelArns } from './model-allowlist';

/** Models per managed policy; measured sizes in lib/utils/claude-model-grant.test.ts. */
export const MODELS_PER_POLICY = 4;

/** `invoke` = InvokeModel (Converse); `stream` adds InvokeModelWithResponseStream (ConverseStream). */
export type ClaudeInvokeVariant = 'invoke' | 'stream';

/**
 * Converse maps to bedrock:InvokeModel and ConverseStream to bedrock:InvokeModelWithResponseStream
 * (https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-call.html).
 */
export const CLAUDE_INVOKE_ACTIONS: Readonly<Record<ClaudeInvokeVariant, readonly string[]>> = {
  invoke: ['bedrock:InvokeModel'],
  stream: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
};

const POLICY_ID_PREFIX: Readonly<Record<ClaudeInvokeVariant, string>> = {
  invoke: 'ClaudeInvokePolicy',
  stream: 'ClaudeInvokeStreamPolicy',
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** The three-part statements for `models` (part 3 only when the scope has a global foundation model). */
function claudeModelStatements(models: readonly ClaudeModelArns[], actions: readonly string[]): iam.PolicyStatement[] {
  const profiles = models.map((m) => m.profile);
  const viaProfile = { 'bedrock:InferenceProfileArn': profiles };
  const statements = [
    new iam.PolicyStatement({ sid: 'ClaudeProfiles', actions: [...actions], resources: profiles }),
    new iam.PolicyStatement({
      sid: 'ClaudeRegionalModels',
      actions: [...actions],
      resources: models.flatMap((m) => m.regionalModels),
      conditions: { StringEquals: viaProfile },
    }),
  ];
  const globalModels = models.flatMap((m) => (m.globalModel === undefined ? [] : [m.globalModel]));
  if (globalModels.length > 0) {
    statements.push(new iam.PolicyStatement({
      sid: 'ClaudeGlobalModels',
      actions: [...actions],
      resources: globalModels,
      conditions: { StringEquals: { 'aws:RequestedRegion': 'unspecified', ...viaProfile } },
    }));
  }
  return statements;
}

/** The stack's shared managed policies for `variant`, created on first use. */
function stackClaudePolicies(scope: IConstruct, variant: ClaudeInvokeVariant): iam.ManagedPolicy[] {
  const stack = cdk.Stack.of(scope);
  return chunk(stackModelArns(stack), MODELS_PER_POLICY).map((models, index) => {
    const id = `${POLICY_ID_PREFIX[variant]}${index}`;
    const existing = stack.node.tryFindChild(id);
    if (existing instanceof iam.ManagedPolicy) return existing;
    return new iam.ManagedPolicy(stack, id, {
      description: `bedrock ${CLAUDE_INVOKE_ACTIONS[variant].join(', ')} on allowlisted Claude models (part ${index + 1})`,
      statements: claudeModelStatements(models, CLAUDE_INVOKE_ACTIONS[variant]),
    });
  });
}

/**
 * Grant `role` `variant` on every allowlisted Claude model (model-allowlist.ts), via the stack's shared policies.
 *
 * When the role already has its CDK default inline policy, that policy is made to depend on the shared ones, so a
 * deploy that moves the grant out of the inline policy (5.75 → this shape) attaches the managed policies BEFORE
 * it removes the inline statements, instead of racing the two updates.
 */
export function grantClaudeModels(role: iam.IRole, variant: ClaudeInvokeVariant): iam.ManagedPolicy[] {
  const policies = stackClaudePolicies(role, variant);
  const defaultPolicy = role.node.tryFindChild('DefaultPolicy');
  for (const policy of policies) {
    policy.attachToRole(role);
    defaultPolicy?.node.addDependency(policy);
  }
  return policies;
}

/** {@link grantClaudeModels} on a function's execution role (CDK-created roles; an imported function has none). */
export function grantClaudeModelsToFunction(fn: lambda.IFunction, variant: ClaudeInvokeVariant): iam.ManagedPolicy[] {
  if (fn.role === undefined) throw new Error(`${fn.node.path} has no execution role to grant Claude models to`);
  return grantClaudeModels(fn.role, variant);
}
