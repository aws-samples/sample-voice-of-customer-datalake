/**
 * Test support: the Bedrock `InvokeModel*` statements on Claude models of a whole-app synth, and the
 * model ARNs one of them misses.
 *
 * A caller's model is resolved at call time (the admin's pick, the e2e profile, a capacity fallback), so
 * EVERY statement that grants a Claude model must grant each model a caller can land on: its
 * inference-profile ARN (`global.` or, with `-c inferenceScope=eu`, `eu.`) AND the foundation-model ARN
 * the profile routes to. A statement that grants a subset AccessDenies exactly the calls that fall
 * through to the missing model, which only shows in production.
 *
 * Not a `*.test.ts` file, so vitest never runs it as a suite.
 */
import { z } from 'zod';

import { sourceStringConstant } from './cross-language-invariants';
import type { SynthResult } from './synth-app';
import type { InferenceScope } from '../utils/inference-scope';
import { scopedModelId, toFoundationModelId } from '../utils/model-allowlist';

const StatementSchema = z.object({
  Effect: z.string().optional(),
  Action: z.union([z.string(), z.array(z.string())]),
  Resource: z.unknown(),
});
const PolicyResourceSchema = z.object({
  Type: z.enum(['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy']),
  Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(StatementSchema) }) }),
});
const ResourcesSchema = z.object({ Resources: z.record(z.string(), z.unknown()) });

export interface ClaudeInvokeStatement {
  /** `<stack>/<policy logical id>#<statement index>`. */
  readonly where: string;
  /** The statement's `Resource`, serialized. */
  readonly resource: string;
}

const isInvoke = (action: string): boolean => action.startsWith('bedrock:InvokeModel');

/** Every Allow statement in the app that grants `bedrock:InvokeModel*` on at least one Claude model. */
export function claudeInvokeStatements(result: SynthResult): ClaudeInvokeStatement[] {
  return result.stackNames.flatMap((stack) => {
    const resources = ResourcesSchema.parse(result.template(stack)).Resources;
    return Object.entries(resources).flatMap(([id, resource]) => {
      const policy = PolicyResourceSchema.safeParse(resource);
      if (!policy.success) return [];
      return policy.data.Properties.PolicyDocument.Statement.flatMap((statement, index) => {
        const resourceText = JSON.stringify(statement.Resource);
        const grants = (statement.Effect ?? 'Allow') === 'Allow'
          && [statement.Action].flat().some(isInvoke)
          && resourceText.includes('anthropic.claude');
        return grants ? [{ where: `${stack}/${id}#${index}`, resource: resourceText }] : [];
      });
    });
  });
}

/** The ARN tails (inference profile under `scope`, foundation model) a statement must name for `modelId`. */
export function requiredModelArnTails(modelId: string, scope: InferenceScope): string[] {
  return [`inference-profile/${scopedModelId(modelId, scope)}`, `foundation-model/${toFoundationModelId(modelId)}`];
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
 * `<where>: <ARN tail>` for every Claude invoke statement that misses one of `modelIds`' ARNs under
 * `scope`. A tail must END a resource string (followed by its closing quote), so `claude-haiku-5-5`
 * is not satisfied by a longer id that merely starts with it.
 */
export function missingModelGrants(statements: readonly ClaudeInvokeStatement[], modelIds: readonly string[], scope: InferenceScope): string[] {
  const tails = modelIds.flatMap((id) => requiredModelArnTails(id, scope));
  return statements.flatMap((statement) => tails
    .filter((tail) => !statement.resource.includes(`${tail}"`))
    .map((tail) => `${statement.where}: ${tail}`));
}
