/**
 * Regenerates lib/test-support/baseline.json — the fingerprint of the
 * NO-PREFIX synth that lib/app-baseline.test.ts compares every synth against.
 *
 *   npx ts-node scripts/generate-baseline.ts
 *
 * Run this ONLY when a change is intended to alter the default templates, and
 * review the diff: this file is the single guard proving that
 * `deploymentPrefix` is opt-in, i.e. that no existing deployment sees its
 * tables, buckets or user pool renamed (which CloudFormation implements as a
 * REPLACEMENT). Regenerating it to make a red test green defeats it entirely.
 *
 * The baseline stores hashes plus a readable name inventory rather than the
 * templates themselves: 600 KB of committed synth output would bury the
 * reviewable diff, and the inventory is what makes a hash change diagnosable.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { nameInventory } from '../lib/test-support/name-inventory';
import { synthApp, BASELINE_PATH, type Baseline } from '../lib/test-support/synth-app';

const result = synthApp();

const stacks: Baseline['stacks'] = {};
for (const stackName of result.stackNames) {
  stacks[stackName] = {
    templateSha256: createHash('sha256').update(result.canonicalTemplate(stackName)).digest('hex'),
    names: nameInventory(result.template(stackName)),
  };
}

const baseline: Baseline = {
  description:
    'Fingerprint of the no-prefix synth. Regenerate with npx ts-node scripts/generate-baseline.ts ' +
    'ONLY for a change intended to alter the default templates — see the script header.',
  stacks,
};

writeFileSync(join(__dirname, '..', BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
console.log(`Wrote ${BASELINE_PATH} for ${result.stackNames.length} stacks: ${result.stackNames.join(', ')}`);
