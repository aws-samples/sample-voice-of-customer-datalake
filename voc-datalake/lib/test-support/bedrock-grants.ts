/**
 * Test support: the Bedrock `InvokeModel*` grants on Claude models of a whole-app synth, per role, and the
 * parts of a model's grant one of them misses.
 *
 * A caller's model is resolved at call time (the admin's pick, the e2e profile, a capacity fallback), so EVERY
 * role that may invoke a Claude model must hold each model a caller can land on, in all the parts AWS
 * authorizes for cross-Region inference (lib/utils/claude-model-grant.ts):
 *  - the inference profile in the app region (`global.`, or `eu.` with `-c inferenceScope=eu`), with no
 *    `bedrock:InferenceProfileArn` condition (Bedrock does not set that key on the profile evaluation);
 *    global: with `aws:RequestedRegion` = the app region;
 *  - the foundation model in the app region (global) or in every destination Region of the `eu.` profile,
 *    with `bedrock:InferenceProfileArn` naming that profile (global: and `aws:RequestedRegion` = the app region);
 *  - global only: the Region-agnostic `arn:aws:bedrock:::foundation-model/<model>`, with
 *    `aws:RequestedRegion` = `unspecified` and the same profile condition.
 * A role missing a part AccessDenies exactly the calls that need it, which only shows in production.
 *
 * Statements are read from inline (`AWS::IAM::Policy`) AND customer-managed (`AWS::IAM::ManagedPolicy`)
 * policies, attributed to every role in their `Roles`. Not a `*.test.ts` file, so vitest never runs it.
 */
import { z } from 'zod';

import { sourceStringConstant } from './cross-language-invariants';
import { SYNTH_ACCOUNT, SYNTH_REGION, type SynthResult } from './synth-app';
import type { InferenceScope } from '../utils/inference-scope';
import { euProfileDestinations, scopedModelId, toFoundationModelId } from '../utils/model-allowlist';

const StringListSchema = z.union([z.string(), z.array(z.string())]).transform((v) => [v].flat());
const StatementSchema = z.object({
  Effect: z.string().optional(),
  Action: StringListSchema,
  Resource: z.unknown(),
  Condition: z.object({ StringEquals: z.record(z.string(), StringListSchema).optional() }).optional(),
});
/** An inline or customer-managed IAM policy resource, with `Action` as a list and `StringEquals` kept. */
export const IamPolicyResourceSchema = z.object({
  Type: z.enum(['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy']),
  Properties: z.object({
    Roles: z.array(z.object({ Ref: z.string() })).optional(),
    PolicyDocument: z.object({ Statement: z.array(StatementSchema) }),
  }),
});
const ResourcesSchema = z.object({ Resources: z.record(z.string(), z.unknown()) });

/** One Allow statement, reduced to what the parts check reads. */
interface ClaudeStatement {
  readonly actions: readonly string[];
  /** Literal resource ARNs (a token-built ARN would not be a plain string and never matches). */
  readonly resources: readonly string[];
  /** `StringEquals` condition values by key. */
  readonly stringEquals: Readonly<Record<string, readonly string[]>>;
}

export interface ClaudeRoleGrant {
  /** `<stack>/<role logical id>`. */
  readonly where: string;
  readonly statements: readonly ClaudeStatement[];
}

const resourceStrings = (resource: unknown): string[] => [resource].flat().filter((r) => typeof r === 'string');

/**
 * Every role of one synthesized template (`Template.toJSON()` or a cloud-assembly template) holding a
 * `bedrock:InvokeModel*` Allow on at least one Claude model, with those statements.
 */
function claudeRoleGrantsOfTemplate(stack: string, template: unknown): ClaudeRoleGrant[] {
  const byRole = new Map<string, ClaudeStatement[]>();
  for (const resource of Object.values(ResourcesSchema.parse(template).Resources)) {
    const policy = IamPolicyResourceSchema.safeParse(resource);
    if (!policy.success) continue;
    const statements = policy.data.Properties.PolicyDocument.Statement
      .filter((s) => (s.Effect ?? 'Allow') === 'Allow' && s.Action.some((a) => a.startsWith('bedrock:InvokeModel')))
      .map((s) => ({ actions: s.Action, resources: resourceStrings(s.Resource), stringEquals: s.Condition?.StringEquals ?? {} }))
      .filter((s) => s.resources.some((r) => r.includes('anthropic.claude')));
    if (statements.length === 0) continue;
    for (const role of policy.data.Properties.Roles ?? []) {
      byRole.set(role.Ref, [...(byRole.get(role.Ref) ?? []), ...statements]);
    }
  }
  return [...byRole].map(([role, statements]) => ({ where: `${stack}/${role}`, statements }));
}

/** {@link claudeRoleGrantsOfTemplate} over every stack of a whole-app synth. */
export function claudeRoleGrants(result: SynthResult): ClaudeRoleGrant[] {
  return result.stackNames.flatMap((stack) => claudeRoleGrantsOfTemplate(stack, result.template(stack)));
}

/** The one role grant whose role logical id starts with `rolePrefix` (throws unless exactly one). */
export function claudeRoleGrantOf(stack: string, template: unknown, rolePrefix: string): ClaudeRoleGrant {
  const found = claudeRoleGrantsOfTemplate(stack, template).filter((g) => g.where.startsWith(`${stack}/${rolePrefix}`));
  const [grant, ...rest] = found;
  if (grant === undefined || rest.length > 0) throw new Error(`expected one Claude grant for ${rolePrefix}, found ${found.length}`);
  return grant;
}

interface RequiredPart {
  readonly label: string;
  readonly arn: string;
  readonly stringEquals: Readonly<Record<string, string>>;
}

/** The parts (ARN + the `StringEquals` values its statement must carry) of `modelId`'s grant under `scope`. */
function requiredParts(modelId: string, scope: InferenceScope, region: string, account: string): RequiredPart[] {
  const model = toFoundationModelId(modelId);
  const profile = `arn:aws:bedrock:${region}:${account}:inference-profile/${scopedModelId(modelId, scope)}`;
  const viaProfile = { 'bedrock:InferenceProfileArn': profile };
  const regions = scope === 'eu' ? euProfileDestinations(region) : [region];
  const inRegion: Record<string, string> = scope === 'eu' ? {} : { 'aws:RequestedRegion': region };
  return [
    { label: `profile ${profile}`, arn: profile, stringEquals: inRegion },
    ...regions.map((r) => ({
      label: `${r} model ${model}`, arn: `arn:aws:bedrock:${r}::foundation-model/${model}`, stringEquals: { ...inRegion, ...viaProfile },
    })),
    ...(scope === 'eu' ? [] : [{
      label: `global model ${model}`,
      arn: `arn:aws:bedrock:::foundation-model/${model}`,
      stringEquals: { 'aws:RequestedRegion': 'unspecified', ...viaProfile },
    }]),
  ];
}

/**
 * Whether `statement` grants `part`: names the ARN exactly and carries exactly its `StringEquals` keys with its
 * values (so a profile part carries no `bedrock:InferenceProfileArn`, which Bedrock never sets on it).
 */
function grantsPart(statement: ClaudeStatement, part: RequiredPart): boolean {
  if (!statement.resources.includes(part.arn)) return false;
  const required = Object.entries(part.stringEquals);
  if (Object.keys(statement.stringEquals).length !== required.length) return false;
  return required.every(([key, value]) => statement.stringEquals[key]?.includes(value) === true);
}

/**
 * The e2e profile's model and its capacity fallback, read from the stream Lambda's copy
 * (lambda/stream/src/bedrock/model-profile.ts `HAIKU55` / `HAIKU45`, the file core-e2e-group.test.ts
 * pins against the Python side), so the grant check follows a model change there.
 */
export function e2eProfileModels(): string[] {
  const file = ['lambda', 'stream', 'src', 'bedrock', 'model-profile.ts'];
  return [sourceStringConstant('HAIKU55', ...file), sourceStringConstant('HAIKU45', ...file)];
}

/**
 * `<where>: <part>` for every role grant that misses a part of one of `modelIds`' grants under `scope`. An ARN
 * must match exactly, so `claude-haiku-5` is not satisfied by `claude-haiku-5-5`.
 */
export function missingModelGrants(
  grants: readonly ClaudeRoleGrant[],
  modelIds: readonly string[],
  scope: InferenceScope,
  region: string = SYNTH_REGION,
): string[] {
  const parts = modelIds.flatMap((id) => requiredParts(id, scope, region, SYNTH_ACCOUNT));
  return grants.flatMap((grant) => parts
    .filter((part) => !grant.statements.some((statement) => grantsPart(statement, part)))
    .map((part) => `${grant.where}: ${part.label}`));
}
