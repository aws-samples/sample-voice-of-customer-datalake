/**
 * scripts/cdk-changed-stacks.mjs: which stacks a `cdk diff --all` output says changed. Anything it
 * cannot read with certainty must come back "unsure", which makes cdk-deploy.sh deploy everything.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const SCRIPT = path.resolve(__dirname, 'cdk-changed-stacks.mjs');

const ResultSchema = z.union([
  z.object({ sure: z.literal(true), changed: z.array(z.string()) }),
  z.object({ sure: z.literal(false), reason: z.string() }),
]);

/** Runs `changedStacks` in a child process (the module is plain ESM JavaScript, as knip-production.test.ts does). */
function parse(output: string): z.infer<typeof ResultSchema> {
  const program = `import { readFileSync } from 'node:fs';
const { changedStacks } = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});
process.stdout.write(JSON.stringify(changedStacks(readFileSync(0, 'utf8'))));`;
  const json = execFileSync(process.execPath, ['--input-type=module', '-e', program], { input: output, encoding: 'utf8' });
  return ResultSchema.parse(JSON.parse(json));
}

const UNCHANGED = (name: string) => `Stack ${name}\nThere were no differences\n`;
const CHANGED = (name: string) => `Stack ${name}\nResources\n[~] AWS::Lambda::Function MetricsApi MetricsApi1234\n └─ [~] Code\n`;
const SUMMARY = (n: number) => `\n✨  Number of stacks with differences: ${n}\n`;

describe('changedStacks', () => {
  it('lists only the stacks with differences, in diff order', () => {
    const output = UNCHANGED('VocWebSearchStack') + CHANGED('VocCoreStack') + UNCHANGED('VocIngestionStack')
      + UNCHANGED('VocProcessingStack') + CHANGED('VocApiStack') + SUMMARY(2);
    expect(parse(output)).toStrictEqual({ sure: true, changed: ['VocCoreStack', 'VocApiStack'] });
  });

  it('reads coloured output and prefixed stack names', () => {
    const output = '\u001b[1mStack \u001b[22mp-VocApiStack\n[+] AWS::ApiGateway::Method x\n'
      + 'Stack \u001b[1mp-VocCoreStack\u001b[22m\n\u001b[32mThere were no differences\u001b[39m\n' + SUMMARY(1);
    expect(parse(output)).toStrictEqual({ sure: true, changed: ['p-VocApiStack'] });
  });

  it('treats a metadata-only diff (hint after the no-differences line) as unchanged', () => {
    const output = 'Stack VocCoreStack\nThere were no differences (CDK metadata changes were hidden, run cdk diff --strict to show)\n'
      + SUMMARY(0);
    expect(parse(output)).toStrictEqual({ sure: true, changed: [] });
  });

  it('returns an empty, trustworthy list when nothing changed', () => {
    expect(parse(UNCHANGED('VocCoreStack') + UNCHANGED('VocApiStack') + SUMMARY(0)))
      .toStrictEqual({ sure: true, changed: [] });
  });

  it.each([
    ['no stack header', 'Synthesis time: 12s\n' + SUMMARY(0), /no "Stack <name>" header/],
    ['no summary line', CHANGED('VocApiStack'), /no "Number of stacks with differences"/],
    ['a summary that disagrees', CHANGED('VocApiStack') + SUMMARY(2), /found 1 changed stack\(s\), the summary says 2/],
    ['a duplicated header', CHANGED('VocApiStack') + CHANGED('VocApiStack') + SUMMARY(2), /appears twice/],
  ])('is unsure with %s', (_label, output, reason) => {
    const result = parse(output);
    expect(result.sure).toBe(false);
    expect(result.sure ? '' : result.reason).toMatch(reason);
  });

  it('exits 3 from the command line when unsure, 0 with one stack per line otherwise', () => {
    expect(execFileSync(process.execPath, [SCRIPT], { input: CHANGED('VocApiStack') + SUMMARY(1), encoding: 'utf8' }))
      .toBe('VocApiStack\n');
    const unsure = spawnSync(process.execPath, [SCRIPT], { input: 'garbage', encoding: 'utf8' });
    expect(unsure.status).toBe(3);
    expect(unsure.stdout).toBe('');
    expect(unsure.stderr).toMatch(/cdk-changed-stacks: unsure/);
  });
});
