/**
 * `-c inferenceScope=eu` across the WHOLE app (docs/eu-deployment.md): every
 * Bedrock-calling Lambda is told to map `global.` → `eu.` at call time, every
 * Bedrock grant names only `eu.` inference profiles, avatars are switched off and
 * the web-search gateway is not deployed. The default (`global`) synth is pinned
 * byte-for-byte by app-baseline.test.ts, which is what proves the flag is opt-in.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cleanupAssemblyDirs, synthApp, SYNTH_TIMEOUT_MS } from './test-support/synth-app';

const StatementSchema = z.object({ Action: z.union([z.string(), z.array(z.string())]), Resource: z.unknown() });
const PolicySchema = z.object({
  Type: z.literal('AWS::IAM::Policy'),
  Properties: z.object({
    Roles: z.array(z.object({ Ref: z.string() })).optional(),
    PolicyDocument: z.object({ Statement: z.array(StatementSchema) }),
  }),
});
const FunctionSchema = z.object({
  Type: z.literal('AWS::Lambda::Function'),
  Properties: z.object({
    Role: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) }).optional(),
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }).optional(),
  }),
});
const TemplateSchema = z.object({ Resources: z.record(z.string(), z.unknown()) });

const eu = synthApp({ inferenceScope: 'eu' });
afterAll(cleanupAssemblyDirs);

// Every template of the eu synth as one searchable text (for "nowhere" assertions).
const allTemplatesText = eu.stackNames.map((stack) => JSON.stringify(eu.template(stack))).join('\n');

const resourcesOf = (stack: string) => Object.entries(TemplateSchema.parse(eu.template(stack)).Resources);

/** Role logical ids (per stack) whose policy may invoke a Bedrock model. */
function bedrockRoles(stack: string): Set<string> {
  return new Set(resourcesOf(stack).flatMap(([, resource]) => {
    const policy = PolicySchema.safeParse(resource);
    if (!policy.success) return [];
    const invokes = policy.data.Properties.PolicyDocument.Statement
      .some((s) => [s.Action].flat().some((a) => a.startsWith('bedrock:InvokeModel')));
    return invokes ? (policy.data.Properties.Roles ?? []).map((role) => role.Ref) : [];
  }));
}

function bedrockFunctions(stack: string) {
  const roles = bedrockRoles(stack);
  return resourcesOf(stack).flatMap(([id, resource]) => {
    const fn = FunctionSchema.safeParse(resource);
    const roleId = fn.data?.Properties.Role?.['Fn::GetAtt'][0];
    return fn.success && roleId !== undefined && roles.has(roleId)
      ? [{ id, env: fn.data.Properties.Environment?.Variables ?? {} }]
      : [];
  });
}

describe('inferenceScope=eu', () => {
  it('finds the Bedrock callers it checks (processor, assistant stream, settings, …)', () => {
    const ids = eu.stackNames.flatMap((stack) => bedrockFunctions(stack).map((fn) => fn.id)).join(' ');
    expect(['FeedbackProcessor', 'ChatStreamApi', 'SettingsApi', 'ProductDocExtractorLambda']
      .filter((name) => !ids.includes(name))).toStrictEqual([]);
  });

  it('tells every Bedrock-calling Lambda BEDROCK_INFERENCE_SCOPE=eu and AVATARS_ENABLED=false', () => {
    const missing = eu.stackNames.flatMap((stack) => bedrockFunctions(stack)
      .filter((fn) => fn.env.BEDROCK_INFERENCE_SCOPE !== 'eu' || fn.env.AVATARS_ENABLED !== 'false')
      .map((fn) => `${stack}/${fn.id}`));
    expect(missing).toStrictEqual([]);
  });

  it('grants no global. inference profile anywhere, and the eu. profiles instead', () => {
    expect(allTemplatesText).not.toMatch(/inference-profile\/global\./);
    expect(allTemplatesText).toContain('inference-profile/eu.anthropic.claude-sonnet-5-5');
  });

  it('does not deploy the web-search gateway, nor hand any Lambda its URL', () => {
    expect(allTemplatesText).not.toContain('AWS::BedrockAgentCore::Gateway');
    expect(allTemplatesText).not.toContain('WEB_SEARCH_GATEWAY_URL');
  });
});

describe('inferenceScope validation', () => {
  it('rejects an unknown scope at synth', () => {
    expect(() => synthApp({ inferenceScope: 'us' })).toThrow(/Invalid -c inferenceScope="us"/);
  }, SYNTH_TIMEOUT_MS);

  it('rejects an explicit enableWebSearch=true with eu', () => {
    expect(() => synthApp({ inferenceScope: 'eu', enableWebSearch: true })).toThrow(/cannot be combined with inferenceScope=eu/);
  }, SYNTH_TIMEOUT_MS);
});
