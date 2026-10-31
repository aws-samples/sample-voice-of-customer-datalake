/**
 * What the app deploys to us-east-1 when the app itself lives elsewhere, and where the Bedrock
 * model agreements go. Ported from PR #429 by @aws-bryan.
 *
 * Some accounts cannot use us-east-1 at all (a region-deny SCP). The promise to them is: leave
 * `anthropicUseCase` unset (the committed default) and deploy with `-c enableWebSearch=false`, and
 * nothing is deployed to, or references, us-east-1. These cases hold the app to that, and to the
 * two things that make it true: the model agreements follow the app's region (VocCoreStack, on every
 * deploy), and Core waits on the us-east-1 stack only when there is a form to submit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { byCodeUnit } from './utils/compare';
import { ALLOWED_FOUNDATION_MODEL_IDS, IMAGE_MODEL_ID } from './utils/model-allowlist';
import { cleanupAssemblyDirs, synthApp, SYNTH_ACCOUNT, SYNTH_TIMEOUT_MS, type SynthResult } from './test-support/synth-app';

const APP_REGION = 'us-west-2';
const AGREEMENT = 'AWS::CloudFormation::CustomResource';

const USE_CASE = {
  companyName: 'Example Air',
  companyWebsite: 'https://example.com',
  intendedUsers: '0',
  industryOption: 'Technology',
  useCases: 'Testing which stacks wait on the use case submission.',
};

const ManifestSchema = z.object({
  artifacts: z.record(z.string(), z.object({
    type: z.string(),
    environment: z.string().optional(),
    dependencies: z.array(z.string()).optional(),
  })),
});
const ResourcesSchema = z.record(z.string(), z.object({ Type: z.string(), Properties: z.unknown() }).loose());
const AgreementPropsSchema = z.object({ modelId: z.string(), region: z.string(), bestEffort: z.string().optional() });

/** Each stack's target environment and the stacks it waits on. */
function stackArtifacts(result: SynthResult): Record<string, { environment?: string; dependsOn: string[] }> {
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(join(result.outdir, 'manifest.json'), 'utf8')));
  return Object.fromEntries(
    Object.entries(manifest.artifacts)
      .filter(([, artifact]) => artifact.type === 'aws:cloudformation:stack')
      .map(([name, artifact]) => [name, {
        environment: artifact.environment,
        dependsOn: (artifact.dependencies ?? []).filter((dep) => !dep.endsWith('.assets')),
      }]),
  );
}

/** The Claude agreements (not the image model's) of one stack. */
function claudeAgreements(result: SynthResult, stack: string): z.infer<typeof AgreementPropsSchema>[] {
  return Object.values(ResourcesSchema.parse(result.template(stack).Resources ?? {}))
    .filter((resource) => resource.Type === AGREEMENT)
    .map((resource) => AgreementPropsSchema.parse(resource.Properties))
    .filter((agreement) => agreement.modelId !== IMAGE_MODEL_ID);
}

const appEnv = `aws://${SYNTH_ACCOUNT}/${APP_REGION}`;
const usEast1Env = `aws://${SYNTH_ACCOUNT}/us-east-1`;

afterAll(cleanupAssemblyDirs);

describe('the committed context submits no use case form', () => {
  it('carries no anthropicUseCase block', () => {
    const committed = z.record(z.string(), z.unknown())
      .parse(JSON.parse(readFileSync(join(__dirname, '..', 'cdk.context.json'), 'utf8')));
    expect(Object.keys(committed)).not.toContain('anthropicUseCase');
  });
});

describe('web search off and no use case form (the opt-out path)', () => {
  const result = synthApp({ enableWebSearch: false }, APP_REGION);

  it('deploys four stacks, all to the app region', () => {
    const stacks = stackArtifacts(result);
    expect(Object.keys(stacks).sort(byCodeUnit)).toStrictEqual(['VocApiStack', 'VocCoreStack', 'VocIngestionStack', 'VocProcessingStack']);
    expect(new Set(Object.values(stacks).map((s) => s.environment))).toStrictEqual(new Set([appEnv]));
  });

  it('mentions us-east-1 in no template', () => {
    // Catches a hard-coded region in a property (an SDK call, an ARN), which
    // the stack environments above cannot see.
    const mentioning = result.stackNames.filter((stack) => JSON.stringify(result.template(stack)).includes('us-east-1'));
    expect(mentioning).toStrictEqual([]);
  });

  it('still creates every Claude agreement, in Core, in the app region, best effort', () => {
    const agreements = claudeAgreements(result, 'VocCoreStack');
    expect(agreements.map((a) => a.modelId).sort(byCodeUnit)).toStrictEqual([...ALLOWED_FOUNDATION_MODEL_IDS].sort(byCodeUnit));
    expect(new Set(agreements.map((a) => `${a.region}/${a.bestEffort}`))).toStrictEqual(new Set([`${APP_REGION}/true`]));
  });
}, SYNTH_TIMEOUT_MS);

describe('web search on, no use case form (the default)', () => {
  const result = synthApp({}, APP_REGION);
  const stacks = stackArtifacts(result);

  it('puts only the gateway stack in us-east-1, with no use-case form or agreement in it', () => {
    expect(stacks.VocWebSearchStack?.environment).toBe(usEast1Env);
    expect(stacks.VocCoreStack?.environment).toBe(appEnv);
    // The submission and the old agreements sat under the `BedrockModelAccess` construct id.
    const resources = ResourcesSchema.parse(result.template('VocWebSearchStack').Resources ?? {});
    expect(Object.keys(resources).filter((id) => id.startsWith('BedrockModelAccess'))).toStrictEqual([]);
  });

  it('does not make Core wait on the us-east-1 stack', () => {
    // With no form, Core has nothing to wait for, and a dependency would drag
    // the us-east-1 stack into `cdk deploy VocCoreStack`.
    expect(stacks.VocCoreStack?.dependsOn).not.toContain('VocWebSearchStack');
  });
}, SYNTH_TIMEOUT_MS);

describe('a use case form to submit (a deployer passes their own block)', () => {
  it('makes Core, which creates the model agreements, wait for the submission', () => {
    const stacks = stackArtifacts(synthApp({ enableWebSearch: false, anthropicUseCase: USE_CASE }, APP_REGION));

    expect(stacks.VocWebSearchStack?.environment).toBe(usEast1Env);
    expect(stacks.VocCoreStack?.dependsOn).toContain('VocWebSearchStack');
  }, SYNTH_TIMEOUT_MS);

  it('submits nothing, and creates no us-east-1 stack, when the submission is skipped', () => {
    const stacks = stackArtifacts(synthApp(
      { enableWebSearch: false, anthropicUseCase: USE_CASE, skipUseCaseSubmission: true },
      APP_REGION,
    ));

    expect(Object.keys(stacks)).not.toContain('VocWebSearchStack');
  }, SYNTH_TIMEOUT_MS);
});
