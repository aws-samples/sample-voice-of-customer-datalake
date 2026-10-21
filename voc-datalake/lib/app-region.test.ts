/**
 * What the app deploys to us-east-1 when the app itself lives elsewhere.
 *
 * Some accounts cannot use us-east-1 at all (a region-deny SCP). The promise to
 * them is: leave `anthropicUseCase` unset (the default) and deploy with
 * `-c enableWebSearch=false`, and nothing is deployed to, or references,
 * us-east-1. These cases hold the app to that, and to the two things that made
 * it true: the model agreements following the app's region (VocCoreStack), and
 * Core waiting on the us-east-1 stack only when there is a form to submit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cleanupAssemblyDirs, synthApp, SYNTH_ACCOUNT, SYNTH_TIMEOUT_MS, type SynthResult } from './test-support/synth-app';

const APP_REGION = 'us-west-2';

const USE_CASE = {
  companyName: 'Test Co',
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

/** Each stack's target environment and the stacks it waits on. */
function stackArtifacts(result: SynthResult) {
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

const appEnv = `aws://${SYNTH_ACCOUNT}/${APP_REGION}`;
const usEast1Env = `aws://${SYNTH_ACCOUNT}/us-east-1`;

afterAll(cleanupAssemblyDirs);

describe('web search off and no use case form (the opt-out path)', () => {
  const result = synthApp({ enableWebSearch: false }, APP_REGION);

  it('deploys four stacks, all to the app region', () => {
    const stacks = stackArtifacts(result);
    expect(Object.keys(stacks).sort()).toEqual(['VocApiStack', 'VocCoreStack', 'VocIngestionStack', 'VocProcessingStack']);
    expect(new Set(Object.values(stacks).map((s) => s.environment))).toEqual(new Set([appEnv]));
  });

  it('mentions us-east-1 in no template', () => {
    // Catches a hard-coded region in a property (an SDK call, an ARN), which
    // the stack environments above cannot see.
    for (const stack of result.stackNames) {
      expect(JSON.stringify(result.template(stack)), stack).not.toContain('us-east-1');
    }
  });
});

describe('web search on, no use case form (the default)', () => {
  const stacks = stackArtifacts(synthApp({}, APP_REGION));

  it('puts only the gateway stack in us-east-1', () => {
    expect(stacks.VocWebSearchStack.environment).toBe(usEast1Env);
    expect(stacks.VocCoreStack.environment).toBe(appEnv);
  });

  it('does not make Core wait on the us-east-1 stack', () => {
    // With no form, Core has nothing to wait for, and a dependency would drag
    // the us-east-1 stack into `cdk deploy VocCoreStack`.
    expect(stacks.VocCoreStack.dependsOn).not.toContain('VocWebSearchStack');
  });
});

describe('a use case form to submit', () => {
  it('makes Core, which creates the model agreements, wait for the submission', () => {
    const stacks = stackArtifacts(synthApp({ enableWebSearch: false, anthropicUseCase: USE_CASE }, APP_REGION));

    expect(stacks.VocWebSearchStack.environment).toBe(usEast1Env);
    expect(stacks.VocCoreStack.dependsOn).toContain('VocWebSearchStack');
  }, SYNTH_TIMEOUT_MS);

  it('submits nothing, and creates no us-east-1 stack, when the submission is skipped', () => {
    const stacks = stackArtifacts(synthApp(
      { enableWebSearch: false, anthropicUseCase: USE_CASE, skipUseCaseSubmission: true },
      APP_REGION,
    ));

    expect(Object.keys(stacks)).not.toContain('VocWebSearchStack');
  }, SYNTH_TIMEOUT_MS);
});
