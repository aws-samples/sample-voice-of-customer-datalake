/**
 * THE guard that makes `deploymentPrefix` safe to merge: with no prefix, the
 * synthesized templates are byte-identical to the ones this repo produced
 * before the flag existed.
 *
 * Why this is a committed test and not a one-off check. A prefix applied
 * unconditionally would rename DynamoDB tables, S3 buckets and the Cognito user
 * pool, and CloudFormation implements a rename of those as a REPLACEMENT — an
 * empty new table beside the old one, i.e. silent data loss on every existing
 * deployment. "Opt-in" is therefore not a nicety, it is the whole safety
 * argument, and an argument nothing enforces decays. The specific way it would
 * decay is ordinary: someone adds a resource, reaches for `prefixed()` or an
 * environment variable "for consistency", and every deployed copy of the
 * platform replaces its data layer on the next `cdk deploy`.
 *
 * lib/test-support/baseline.json was generated FROM THE PRE-CHANGE COMMIT, so
 * this compares against history rather than against the code under test.
 * Regenerating it is a deliberate act with its own instructions — see
 * scripts/generate-baseline.ts.
 *
 * Asset hashes are normalized out (see SynthResult.canonicalTemplate): they
 * digest the Lambda source tree, so they move on any Python edit, including the
 * ones this change necessarily made to two handlers. Naming is what is pinned.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { nameInventory } from './test-support/name-inventory';
import { BASELINE_PATH, diagnostics, synthApp, type Baseline } from './test-support/synth-app';

const PROJECT_ROOT = join(__dirname, '..');

/**
 * Parsed at the boundary with zod rather than an `as` assertion (repo
 * convention, and a malformed baseline must fail loudly rather than compare
 * `undefined` against `undefined` and pass).
 */
const NameInventorySchema = z.object({
  physicalNames: z.array(z.string()),
  exportNames: z.array(z.string()),
  policyResources: z.array(z.string()),
  environmentNames: z.array(z.string()),
});
const BaselineSchema = z.object({
  description: z.string(),
  stacks: z.record(z.string(), z.object({
    templateSha256: z.string().regex(/^[0-9a-f]{64}$/),
    names: NameInventorySchema,
  })),
});

function loadBaseline(): Baseline {
  const raw: unknown = JSON.parse(readFileSync(join(PROJECT_ROOT, BASELINE_PATH), 'utf8'));
  return BaselineSchema.parse(raw);
}

// One synth for the whole file: it shells out to bin/voc-datalake.ts and is the
// expensive part of the suite.
const baseline = loadBaseline();
const synthed = synthApp();

describe('the default (no deploymentPrefix) synth', () => {
  it('produces exactly the stacks the baseline recorded', () => {
    expect(synthed.stackNames).toEqual(Object.keys(baseline.stacks).sort());
  });

  it.each(Object.keys(baseline.stacks))(
    'keeps every %s name byte-identical to the pre-change template',
    (stackName) => {
      // Assert the READABLE inventory before the hash, deliberately: when this
      // file fails, the message should say which name moved, not just that a
      // digest did. The hash then catches everything the inventory does not
      // model (resource shape, policy actions, output values).
      const names = nameInventory(synthed.template(stackName));
      expect(names).toEqual(baseline.stacks[stackName].names);

      const sha = createHash('sha256').update(synthed.canonicalTemplate(stackName)).digest('hex');
      expect(
        sha,
        `${stackName}.template.json changed against ${BASELINE_PATH}. If that is intended, ` +
          'regenerate with `npx ts-node scripts/generate-baseline.ts` AND review the diff: ' +
          'renaming a table, bucket or user pool is a CloudFormation REPLACEMENT.',
      ).toBe(baseline.stacks[stackName].templateSha256);
    },
  );

  it('carries no deployment prefix anywhere in a name', () => {
    // The inventory equality above already implies this, but state it directly:
    // it is the invariant, and it must not depend on reading a hash.
    for (const stackName of synthed.stackNames) {
      const names = nameInventory(synthed.template(stackName));
      for (const name of [...names.physicalNames, ...names.exportNames, ...names.policyResources]) {
        expect(name).not.toMatch(/[= :/]\w+-voc-/);
      }
    }
  });

  it('synthesizes with zero warnings', () => {
    // A clean `cdk synth` prints nothing; a new synth or cdk-nag warning is a
    // regression, not noise. `readsRealAnnotations` first, because an empty
    // annotation list would otherwise read as "clean" whether the synth was
    // clean or the collector was looking in the wrong place
    // (lib/test-support/synth-app.test.ts pins the collector itself).
    expect(synthed.readsRealAnnotations, 'the annotation collector found nothing at all').toBe(true);
    const found = diagnostics(synthed);
    expect(found, JSON.stringify(found, null, 2)).toEqual([]);
  });
});
