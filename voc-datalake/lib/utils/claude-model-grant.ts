/**
 * The `bedrock:InvokeModel*` grant on every allowlisted Claude model, in the three-part shape AWS documents for
 * cross-Region inference, with no Region wildcard:
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html  (global, default)
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html (`-c inferenceScope=eu`)
 *
 *  1. `ClaudeProfiles`: the inference profiles in the app region (the `modelId` every caller sends). No
 *     `bedrock:InferenceProfileArn` condition: Bedrock does not populate it on the profile evaluation.
 *  2. `ClaudeRegionalModels`: the foundation models in the app region (global) or in every destination Region of
 *     the `eu.` profiles (eu, model-allowlist.ts EU_PROFILE_DESTINATION_REGIONS), only through one of those profiles.
 *  3. `ClaudeGlobalModels` (global only): the Region-agnostic `arn:…:bedrock:::foundation-model/<model>`, for which
 *     Bedrock sets `aws:RequestedRegion` to `unspecified`, again only through one of the profiles.
 * Global: parts 1 and 2 also carry `aws:RequestedRegion` = the app region, exactly as the global doc's example.
 * Eu: no `aws:RequestedRegion`, exactly as the geographic doc's example.
 *
 * The statements live in customer-managed policies SHARED by every Bedrock role of a stack (one set per action
 * variant), not in each role's inline policy: three parts per model on ~23 roles would push the largest inline
 * policies (Settings ~5.6 KB of 10,240) past the 70% guard in api-stack-mcp.test.ts. Each managed policy carries
 * {@link MODELS_PER_POLICY} models so it stays under 70% of the 6,144-character managed quota in both scopes
 * (an eu policy lists 6–7 destination Regions per model).
 *
 * The image model and the Titan embedder are in-Region models invoked directly; their exact ARNs stay in the
 * callers' own statements (model-allowlist.ts imageModelArn / embeddingModelArn).
 *
 * The deployment's own models (`-c customModels`, custom-models.ts, 7.65.00) join the same shared policies, each by
 * its exact ARNs (an in-Region or imported model directly; a profile in the same three-part shape), spread over the
 * policies so each stays under the 6,144-character quota (checked at synth). A role granted with
 * `{ customModels: false }` (the engineering runtime: its harness is Claude-only) attaches a Claude-only twin set
 * instead, made only when custom models exist, so without the flag every template is unchanged.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IConstruct } from 'constructs';

import { customModelArns, type CustomModel, markCustomModelRole, stackCustomModels } from './custom-models';
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
/** The Claude-only twin set's, made beside the shared set only when `-c customModels` lists a model. */
const TWIN_POLICY_ID_PREFIX: Readonly<Record<ClaudeInvokeVariant, string>> = {
  invoke: 'ClaudeOnlyInvokePolicy',
  stream: 'ClaudeOnlyInvokeStreamPolicy',
};

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** IAM's quota on a customer-managed policy document, in characters without whitespace. */
const MANAGED_POLICY_CHARS = 6_144;

/** The one `requestingRegion` of `models` (global scope), or undefined (eu); throws on a mix. */
function requestingRegionOf(models: readonly ClaudeModelArns[]): string | undefined {
  const regions = new Set(models.map((m) => m.requestingRegion));
  const [region, ...rest] = regions;
  if (rest.length > 0) throw new Error(`Claude grant models disagree on the requesting region: ${[...regions].join(', ')}`);
  return region;
}

/** The three-part statements for `models` (part 3 only when the scope has a global foundation model), their Sids
 *  prefixed `sid` (`Claude` for the allowlist). */
function claudeModelStatements(models: readonly ClaudeModelArns[], actions: readonly string[], sid = 'Claude'): iam.PolicyStatement[] {
  if (models.length === 0) return [];
  const profiles = models.map((m) => m.profile);
  const viaProfile = { 'bedrock:InferenceProfileArn': profiles };
  const requesting = requestingRegionOf(models);
  const inRegion = requesting === undefined ? {} : { 'aws:RequestedRegion': requesting };
  const statements = [
    new iam.PolicyStatement({
      sid: `${sid}Profiles`,
      actions: [...actions],
      resources: profiles,
      ...(requesting === undefined ? {} : { conditions: { StringEquals: inRegion } }),
    }),
    new iam.PolicyStatement({
      sid: `${sid}RegionalModels`,
      actions: [...actions],
      resources: models.flatMap((m) => m.regionalModels),
      conditions: { StringEquals: { ...inRegion, ...viaProfile } },
    }),
  ];
  const globalModels = models.flatMap((m) => (m.globalModel === undefined ? [] : [m.globalModel]));
  if (globalModels.length > 0) {
    statements.push(new iam.PolicyStatement({
      sid: `${sid}GlobalModels`,
      actions: [...actions],
      resources: globalModels,
      conditions: { StringEquals: { 'aws:RequestedRegion': 'unspecified', ...viaProfile } },
    }));
  }
  return statements;
}

/**
 * The statements for the deployment's own `models`: the in-Region and imported models by their ARNs
 * (`CustomModels`), a `global.` profile in the three parts (`CustomCrossRegion*`), any other profile in the
 * geographic two (`CustomGeo*`, each foundation model in each of its Regions, through the profile only).
 */
function customModelStatements(models: readonly CustomModel[], stack: cdk.Stack, actions: readonly string[]): iam.PolicyStatement[] {
  const grants = models.map((model) => customModelArns(model, stack));
  const direct = grants.flatMap((grant) => (grant.kind === 'direct' ? [grant.arn] : []));
  const profiles = grants.flatMap((grant) => (grant.kind === 'profile' ? [grant.arns] : []));
  return [
    ...(direct.length > 0 ? [new iam.PolicyStatement({ sid: 'CustomModels', actions: [...actions], resources: direct })] : []),
    ...claudeModelStatements(profiles.filter((p) => p.globalModel !== undefined), actions, 'CustomCrossRegion'),
    ...claudeModelStatements(profiles.filter((p) => p.globalModel === undefined), actions, 'CustomGeo'),
  ];
}

/** Throws when `statements` would not fit one managed policy (IAM counts the document without whitespace). A guard:
 *  the registry's own caps (four models, 1,200 characters) keep the largest grant at 86 % of the quota
 *  (claude-model-grant.test.ts). */
export function assertFitsManagedPolicy(stack: cdk.Stack, id: string, statements: readonly iam.PolicyStatement[]): void {
  const chars = JSON.stringify(stack.resolve(new iam.PolicyDocument({ statements: [...statements] }).toJSON())).length;
  if (chars > MANAGED_POLICY_CHARS) {
    throw new Error(`${stack.stackName}/${id}: the Claude and custom model grant is ${chars} characters, over the `
      + `${MANAGED_POLICY_CHARS}-character managed-policy quota: list fewer -c customModels (or Regions)`);
  }
}

/**
 * The stack's shared managed policies for `variant`, created on first use: the Claude allowlist in
 * {@link MODELS_PER_POLICY} chunks, the custom models spread over the chunks (model `j` in chunk `j mod n`). With
 * `withCustom` false and custom models present, the Claude-only twin set (`ClaudeOnly…`) instead.
 */
function stackClaudePolicies(scope: IConstruct, variant: ClaudeInvokeVariant, withCustom: boolean): iam.ManagedPolicy[] {
  const stack = cdk.Stack.of(scope);
  const custom = stackCustomModels(stack);
  const twin = custom.length > 0 && !withCustom;
  const chunks = chunk(stackModelArns(stack), MODELS_PER_POLICY);
  return chunks.map((models, index) => {
    const id = `${(twin ? TWIN_POLICY_ID_PREFIX : POLICY_ID_PREFIX)[variant]}${index}`;
    const existing = stack.node.tryFindChild(id);
    if (existing instanceof iam.ManagedPolicy) return existing;
    const actions = CLAUDE_INVOKE_ACTIONS[variant];
    const own = twin ? [] : custom.filter((_, j) => j % chunks.length === index);
    const statements = [...claudeModelStatements(models, actions), ...customModelStatements(own, stack, actions)];
    if (own.length > 0) assertFitsManagedPolicy(stack, id, statements);
    const subject = own.length > 0 ? 'allowlisted Claude models and the deployment\'s custom models' : 'allowlisted Claude models';
    return new iam.ManagedPolicy(stack, id, {
      description: `bedrock ${actions.join(', ')} on ${subject} (part ${index + 1})`,
      statements,
    });
  });
}

/**
 * Makes a role's CDK default inline policy wait for the shared Claude policies, whenever that default policy is
 * created (a role's first `addToPolicy` may come before or after its Claude grant): an aspect, so the order of the
 * grants in a stack does not matter.
 */
class DefaultPolicyAfterClaudePolicies implements cdk.IAspect {
  constructor(private readonly policies: readonly iam.ManagedPolicy[]) {}

  public visit(node: IConstruct): void {
    if (node instanceof iam.Policy && node.node.id === 'DefaultPolicy') {
      for (const policy of this.policies) node.node.addDependency(policy);
    }
  }
}

/** How a role is granted the models. */
export interface ClaudeGrantOptions {
  /** `false`: the Claude allowlist only, never a `-c customModels` model (the engineering runtime, Claude-only). */
  readonly customModels?: boolean;
}

/**
 * Grant `role` `variant` on every allowlisted Claude model (model-allowlist.ts) and, unless `customModels` is
 * false, on every `-c customModels` model (custom-models.ts), via the stack's shared policies.
 *
 * The role's default inline policy is made to depend on the shared ones, so a deploy that moves the grant out of
 * the inline policy (5.76 → this shape) attaches the managed policies BEFORE it removes the inline statements,
 * instead of racing the two updates.
 */
export function grantClaudeModels(role: iam.IRole, variant: ClaudeInvokeVariant, options: ClaudeGrantOptions = {}): iam.ManagedPolicy[] {
  const withCustom = options.customModels ?? true;
  if (withCustom) markCustomModelRole(role);
  const policies = stackClaudePolicies(role, variant, withCustom);
  for (const policy of policies) policy.attachToRole(role);
  cdk.Aspects.of(role).add(new DefaultPolicyAfterClaudePolicies(policies));
  return policies;
}

/** {@link grantClaudeModels} on a function's execution role (CDK-created roles; an imported function has none). */
export function grantClaudeModelsToFunction(fn: lambda.IFunction, variant: ClaudeInvokeVariant,
  options: ClaudeGrantOptions = {}): iam.ManagedPolicy[] {
  if (fn.role === undefined) throw new Error(`${fn.node.path} has no execution role to grant Claude models to`);
  return grantClaudeModels(fn.role, variant, options);
}
