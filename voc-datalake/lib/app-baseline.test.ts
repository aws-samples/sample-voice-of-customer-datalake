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

import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { nameInventory, unlistedNameProperties } from './test-support/name-inventory';
import {
  BASELINE_PATH,
  cleanupAssemblyDirs,
  diagnostics,
  synthApp,
  SYNTH_TIMEOUT_MS,
  type Baseline,
} from './test-support/synth-app';

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

/**
 * A name carrying a deployment prefix ahead of the `voc` stem.
 *
 * `[a-z0-9][a-z0-9-]*` rather than `\w+`: `\w` excludes the hyphen, and
 * `validateDeploymentPrefix` accepts inner hyphens (`team-a`), so `\w` would
 * have let exactly the prefixes this repo documents slip past. The negative
 * lookahead keeps the plain `voc-` stem — and `Voc...` in an export name — from
 * matching itself.
 */
const PREFIXED_NAME = /[= :/](?![Vv]oc)[a-z0-9][a-z0-9-]*-voc-/;

// One synth for the whole file: it shells out to bin/voc-datalake.ts and is the
// expensive part of the suite.
const baseline = loadBaseline();
const synthed = synthApp();

// The assembly is ~26 MB and every template read above comes out of it, so it
// has to survive the whole file — and be gone afterwards. Vitest kills its
// workers, so synth-app.ts's `process.on('exit')` hook does not run here.
afterAll(cleanupAssemblyDirs);

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

  it('inventories every property CloudFormation actually carries a name in', () => {
    // The inventory is only as exhaustive as its list of property names, and a
    // list that is too narrow fails OPEN: a missed name never appears, so both
    // the equality above and the exhaustive prefix mapping pass while saying
    // nothing about it. Four names were in exactly that state — the KMS alias,
    // the Cognito hosted-UI domain, the user-pool client name and the API usage
    // plan — because the list held CDK L2 property spellings (`Alias`,
    // `DomainPrefix`, `UserPoolClientName`, `RestApiName`) that never appear in
    // a template at all.
    for (const stackName of synthed.stackNames) {
      expect(
        unlistedNameProperties(synthed.template(stackName)),
        `${stackName}: these render to a VoC name but no inventory watches them. Add the ` +
          'CloudFormation property name to NAME_PROPERTIES in lib/test-support/name-inventory.ts ' +
          '(and regenerate the baseline), or establish that it is not a physical name.',
      ).toEqual([]);
    }
  });

  it('would flag a name-bearing property that the inventory does not list', () => {
    // The complement, so the assertion above cannot pass by never detecting
    // anything: an empty result has to mean "nothing unlisted", not "the
    // detector looks in the wrong place".
    const template = {
      Resources: {
        Thing: { Type: 'AWS::Service::Thing', Properties: { ThingName: 'voc-thing-not-in-the-list' } },
      },
    };
    expect(unlistedNameProperties(template))
      .toEqual(['AWS::Service::Thing ThingName = voc-thing-not-in-the-list']);
    // ...and a listed property, or a property with no VoC name, is not flagged.
    expect(unlistedNameProperties({
      Resources: {
        Table: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'voc-feedback' } },
        Other: { Type: 'AWS::Service::Thing', Properties: { ThingName: 'unrelated' } },
      },
    })).toEqual([]);
    // ...and something established NOT to be a physical name can be exempted
    // without adding it to NAME_PROPERTIES, which would feed a non-name into the
    // baseline inventory and the prefix mapping. Nothing in the app needs this
    // today, so the escape hatch is proven here rather than by a standing list.
    expect(unlistedNameProperties({
      Resources: {
        Thing: { Type: 'AWS::Service::Thing', Properties: { Description: 'the voc-feedback table' } },
      },
    }, ['Description'])).toEqual([]);
  });

  it('carries no deployment prefix anywhere in a name', () => {
    // The inventory equality above already implies this, but state it directly:
    // it is the invariant, and it must not depend on reading a hash.
    for (const stackName of synthed.stackNames) {
      const names = nameInventory(synthed.template(stackName));
      for (const name of [...names.physicalNames, ...names.exportNames, ...names.policyResources]) {
        expect(name).not.toMatch(PREFIXED_NAME);
      }
    }
  });

  it('detects a hyphenated prefix, which `\\w` would have missed', () => {
    // Defence in depth on the check above, and a real gap that was there:
    // `\w` excludes `-`, so `team-a` — which validateDeploymentPrefix explicitly
    // accepts and naming.test.ts covers — read as unprefixed. The sha equality
    // earlier in this file would still have caught a genuine leak, but this
    // assertion exists precisely so the invariant does not depend on reading a
    // hash, and half-doing that is worse than not doing it.
    expect('AWS::DynamoDB::Table TableName = team-a-voc-feedback-123456789012-us-east-1').toMatch(PREFIXED_NAME);
    expect('AWS::Logs::LogGroup LogGroupName = /aws/lambda/team-a-voc-x').toMatch(PREFIXED_NAME);
    expect('AWS::DynamoDB::Table TableName = stg-voc-feedback-123456789012-us-east-1').toMatch(PREFIXED_NAME);

    // ...and does not fire on the unprefixed names the app really produces,
    // including the ones whose own base name contains a hyphen.
    expect('AWS::DynamoDB::Table TableName = voc-feedback-123456789012-us-east-1').not.toMatch(PREFIXED_NAME);
    expect('AWS::S3::Bucket BucketName = voc-access-logs-123456789012-us-east-1').not.toMatch(PREFIXED_NAME);
    expect('AWS::Logs::LogGroup LogGroupName = /aws/lambda/voc-ingestor-webscraper').not.toMatch(PREFIXED_NAME);
    expect('Outputs Export.Name = VocCoreStack:ExportsOutputRefFeedbackTable').not.toMatch(PREFIXED_NAME);
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
// SYNTH_TIMEOUT_MS rather than a global testTimeout: only the suites that
// synthesize the whole app out of process need longer than vitest's 5s default,
// and raising it globally would delay every other suite's hung-test report.
}, SYNTH_TIMEOUT_MS);
