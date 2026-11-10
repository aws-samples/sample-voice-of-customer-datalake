/**
 * `npm run generate:workshop-artifacts` synthesizes the templates Workshop Studio deploys into a
 * temporary account. A workshop must leave nothing behind when its stacks are deleted, so the synth
 * runs with `-c protectData=false` (docs/deployment.md, "Production: protectData"). Without it the
 * tables, user pools, KMS key, buckets and log groups survive the teardown, and the next deploy into
 * the same account fails with "already exists". What that flag does to the templates is pinned by
 * lib/stacks/core-stack-teardown.test.ts and lib/utils/protected-deployment.test.ts; this file pins
 * that the workshop script passes it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const PackageJsonSchema = z.object({ scripts: z.record(z.string(), z.string()) });
const packageJson = PackageJsonSchema.parse(JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')));
const script = packageJson.scripts['generate:workshop-artifacts'] ?? '';

/** The `-c key=value` pairs of the `cdk synth` command in the script, in order. */
function synthContext(command: string): Array<[string, string]> {
  const synth = command.split('&&').map((part) => part.trim()).find((part) => part.startsWith('npx cdk synth')) ?? '';
  return [...synth.matchAll(/(?:^|\s)-c\s+([A-Za-z0-9_]+)=(\S+)/g)].map((match) => [match[1] ?? '', match[2] ?? '']);
}

describe('generate:workshop-artifacts', () => {
  it('exists and runs a cdk synth (a renamed script would make the checks below meaningless)', () => {
    expect(script).toMatch(/(^|&&)\s*npx cdk synth /);
  });

  it('synthesizes unprotected templates, so deleting a workshop stack deletes its data', () => {
    expect(synthContext(script)).toContainEqual(['protectData', 'false']);
  });

  it('sets protectData exactly once, so a later flag cannot turn the protection back on', () => {
    expect(synthContext(script).filter(([key]) => key === 'protectData')).toHaveLength(1);
  });

  it('reads the -c pairs of the synth command only, never of the converter that follows it', () => {
    expect(synthContext('npx cdk synth --all -c a=1 -c protectData=false && node convert.mjs -c protectData=true')).toEqual([
      ['a', '1'],
      ['protectData', 'false'],
    ]);
  });
});
