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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { describe, expect, it } from 'vitest';

import { pluginSystemSuppressions } from '../utils/nag-suppressions';
import { diagnostics, readAssembly, SYNTH_ACCOUNT, SYNTH_REGION } from './synth-app';

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
  const outdir = mkdtempSync(join(tmpdir(), 'voc-nag-'));
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
