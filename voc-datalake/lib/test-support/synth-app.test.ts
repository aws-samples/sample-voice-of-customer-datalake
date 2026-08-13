/**
 * The guard on the guard: proves the annotation collector in synth-app.ts
 * actually finds cdk-nag findings.
 *
 * Every "synthesizes with zero warnings" assertion in lib/app-baseline.test.ts
 * and lib/app-deployment-prefix.test.ts compares a list against `[]`, and an
 * empty list is indistinguishable from a clean synth. That is not hypothetical:
 * the collector originally read `manifest.json`'s `artifacts[*].metadata`, which
 * cloud assembly manifest v54 leaves absent — findings moved to per-stack
 * `<stack>.metadata.json` files. So the list was always empty, both assertions
 * were vacuous, and four AwsSolutions-IAM5 errors on a prefixed synth went
 * unreported.
 *
 * The fix is only trustworthy with a case whose findings are KNOWN, which is
 * what this file supplies: a two-resource stack with one deliberate IAM5
 * wildcard, synthesized to a real assembly directory and read back through the
 * same code path the app suites use.
 *
 * It doubles as the unit-level guard on `pluginSystemSuppressions()` being a
 * function of the deployment prefix — the same finding must be suppressed under
 * a prefix and reported when the suppression is built for the wrong one.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { afterAll, describe, expect, it } from 'vitest';

import { pluginSystemSuppressions } from '../utils/nag-suppressions';
import {
  cleanupAssemblyDirs,
  createAssemblyDir,
  diagnostics,
  DIAGNOSTIC_ANNOTATION_TYPES,
  readAssembly,
  SYNTH_ACCOUNT,
  SYNTH_REGION,
  type SynthAnnotation,
} from './synth-app';

/**
 * Synthesize a stack holding one ingestor-invoke wildcard — the shape of the
 * three grants in api-stack.ts — to a real assembly directory, and read it back
 * through {@link readAssembly}.
 *
 * @param prefix        the deployment prefix the ARN carries
 * @param suppressFor   the prefix the suppression is BUILT for; `null` applies
 *                      no suppression at all
 */
function synthIngestorGrant(
  prefix: string | undefined,
  suppressFor: string | undefined | null,
): ReturnType<typeof readAssembly> {
  const outdir = createAssemblyDir('voc-nag-');
  const app = new cdk.App({ outdir });
  const stack = new cdk.Stack(app, 'NagProbeStack', {
    env: { account: SYNTH_ACCOUNT, region: SYNTH_REGION },
  });
  cdk.Aspects.of(app).add(new AwsSolutionsChecks());

  const role = new iam.Role(stack, 'IngestorInvokerRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  });
  const namePrefix = prefix ? `${prefix}-` : '';
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['lambda:InvokeFunction'],
    resources: [`arn:aws:lambda:${SYNTH_REGION}:${SYNTH_ACCOUNT}:function:${namePrefix}voc-ingestor-*`],
  }));
  if (suppressFor !== null) {
    NagSuppressions.addResourceSuppressions(role, pluginSystemSuppressions(suppressFor), true);
  }

  app.synth();
  return readAssembly(outdir);
}

// Every assembly this file creates. Vitest kills its workers, so synth-app.ts's
// `process.on('exit')` hook never runs here.
afterAll(cleanupAssemblyDirs);

/** The AwsSolutions findings in an assembly, whatever their severity. */
function nagFindings(result: ReturnType<typeof readAssembly>): string[] {
  return diagnostics(result)
    .filter((annotation) => annotation.data.includes('AwsSolutions-'))
    .map((annotation) => `${annotation.type} ${annotation.path} ${annotation.data.split(':')[0]}`);
}

describe('the annotation collector', () => {
  it('reports a cdk-nag finding that no suppression covers', () => {
    // If this is empty, every zero-warnings assertion in the suite is vacuous —
    // which is precisely the state this file was written to end.
    const result = synthIngestorGrant('b', null);
    expect(result.readsRealAnnotations).toBe(true);
    expect(nagFindings(result).join('\n')).toContain('AwsSolutions-IAM5');
  });

  it('sees the annotations CDK always emits, so an empty list means a broken collector', () => {
    // `aws:cdk:logicalId` is on every resource in every assembly. Its absence
    // can only mean the collector is reading the wrong file.
    const result = synthIngestorGrant(undefined, null);
    expect(result.annotations.map((annotation) => annotation.type)).toContain('aws:cdk:logicalId');
  });
});

describe('pluginSystemSuppressions', () => {
  it('suppresses the ingestor wildcard on an unprefixed deployment', () => {
    expect(nagFindings(synthIngestorGrant(undefined, undefined))).toEqual([]);
  });

  it('suppresses the ingestor wildcard on a prefixed deployment', () => {
    // The finding quotes the concrete ARN — `function:b-voc-ingestor-*` — so a
    // suppression regex hardcoded to `function:voc-ingestor-` stops matching and
    // leaves an unsuppressed IAM5 error on every prefixed synth.
    expect(nagFindings(synthIngestorGrant('b', 'b'))).toEqual([]);
  });

  it('still reports the finding when built for the wrong prefix', () => {
    // The complement: the suppression must be narrow enough that it can miss.
    // Without this, a suppression matching everything would pass the case above
    // while suppressing findings it was never meant to.
    expect(nagFindings(synthIngestorGrant('b', undefined)).join('\n')).toContain('AwsSolutions-IAM5');
    expect(nagFindings(synthIngestorGrant(undefined, 'b')).join('\n')).toContain('AwsSolutions-IAM5');
  });
});

describe('what counts as a diagnostic', () => {
  const annotation = (type: string, data: string): SynthAnnotation =>
    ({ stack: 'VocWebSearchStack', path: '/VocWebSearchStack/Resource', type, data });

  it('keeps warnings and errors, and ignores the info annotation the app raises on purpose', () => {
    // bin/voc-datalake.ts calls `Annotations.addInfo(...)` whenever the app
    // region is not us-east-1 — the issue #205 bootstrap hint. Counting
    // `aws:cdk:info` as a diagnostic would therefore turn correct behaviour into
    // a red "synthesizes with zero warnings" in both app suites as soon as the
    // synth region moved off the pinned us-east-1.
    const annotations = [
      annotation('aws:cdk:info', 'Web search deploys by default and requires a us-east-1 bootstrap'),
      annotation('aws:cdk:logicalId', 'VocThing'),
      annotation('aws:cdk:warning', 'No cross-stack-reference strength configured'),
      annotation('aws:cdk:error', 'AwsSolutions-IAM5[Resource::*]'),
    ];
    expect(diagnostics({ annotations }).map((found) => found.type))
      .toEqual(['aws:cdk:warning', 'aws:cdk:error']);
    expect(DIAGNOSTIC_ANNOTATION_TYPES).not.toContain('aws:cdk:info');
  });
});

describe('the two annotation sources', () => {
  /**
   * A minimal assembly: `manifest.json` carrying artifact metadata (the v53 and
   * earlier shape) plus, for some stacks, a per-stack side file (v54).
   */
  function fakeAssembly(manifestStacks: string[], sideFileStacks: string[]): string {
    const outdir = createAssemblyDir('voc-annotations-');
    const entry = [{ type: 'aws:cdk:warning', data: 'the one warning' }];
    const artifacts = Object.fromEntries(
      manifestStacks.map((stack) => [stack, { metadata: { [`/${stack}/Resource`]: entry } }]),
    );
    writeFileSync(join(outdir, 'manifest.json'), JSON.stringify({ version: '54.0.0', artifacts }));
    for (const stack of sideFileStacks) {
      writeFileSync(join(outdir, `${stack}.metadata.json`), JSON.stringify({ [`/${stack}/Resource`]: entry }));
    }
    return outdir;
  }

  it('counts an annotation once when a stack appears in both', () => {
    // Additive collection would report it twice — invisible to `toEqual([])` and
    // silently wrong for any count, which is how the ORIGINAL collector bug
    // (reading only the absent manifest key) stayed hidden.
    const result = readAssembly(fakeAssembly(['BothStack'], ['BothStack']));
    expect(diagnostics(result)).toHaveLength(1);
  });

  it('still falls back to the manifest for a stack with no side file', () => {
    // The hedge has to keep working: this is the v53-and-earlier shape, and
    // dropping it would re-create the "collector silently finds nothing" failure
    // on an older manifest version.
    const result = readAssembly(fakeAssembly(['ManifestOnlyStack'], []));
    expect(diagnostics(result).map((found) => found.stack)).toEqual(['ManifestOnlyStack']);
  });
});

// Last in the file on purpose: it drains every assembly directory this process
// created, so nothing above may still need to read one.
describe('assembly directory cleanup', () => {
  it('removes the directories it handed out', () => {
    // What `afterAll(cleanupAssemblyDirs)` in each synth suite relies on. Worth
    // its own case because the FIRST cleanup mechanism here — a
    // `process.on('exit')` hook — looked right and did nothing under vitest,
    // which kills its workers instead of letting them exit: 22 assemblies
    // (~26 MB each) survived a full run that had it.
    const dir = createAssemblyDir('voc-cleanup-probe-');
    expect(existsSync(dir)).toBe(true);
    cleanupAssemblyDirs();
    expect(existsSync(dir)).toBe(false);
  });
});
