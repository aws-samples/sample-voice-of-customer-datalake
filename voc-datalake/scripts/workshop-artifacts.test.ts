/**
 * `npm run generate:workshop-artifacts` synthesizes the templates Workshop Studio deploys into a
 * temporary account. A workshop must leave nothing behind when its stacks are deleted, so the synth
 * runs with `-c protectData=false` (docs/deployment.md, "Production: protectData"). Without it the
 * tables, user pools, KMS key, buckets and log groups survive the teardown, and the next deploy into
 * the same account fails with "already exists".
 *
 * What the flag does to the templates is pinned elsewhere, with the CLI's string value too:
 * lib/utils/data-protection.test.ts reads 'false' as unprotected, and
 * lib/stacks/core-stack-teardown.test.ts and lib/stacks/email-intake.test.ts pin the teardown shape
 * (deletion policies, no deletion protection, auto-deleted buckets). This file pins that the workshop
 * script passes the flag, next to the other values the workshop depends on.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const PackageJsonSchema = z.object({ scripts: z.record(z.string(), z.string()) });
const packageJson = PackageJsonSchema.parse(
  JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')),
);
const script = packageJson.scripts['generate:workshop-artifacts'] ?? '';

/** The five stacks of the app, in deploy order (docs/deployment.md: at most five templates). */
const WORKSHOP_STACKS = ['VocWebSearchStack', 'VocCoreStack', 'VocIngestionStack', 'VocProcessingStack', 'VocApiStack'];

const commandsOf = (command: string): string[] => command.split('&&').map((part) => part.trim());

/** The context pairs (`-c k=v` or `--context k=v`) of the `cdk synth` command in the script, in order. */
function synthContext(command: string): Array<[string, string]> {
  const synth = commandsOf(command).find((part) => part.startsWith('npx cdk synth')) ?? '';
  return [...synth.matchAll(/(?:^|\s)(?:-c|--context)[\s=]+(\w+)=(\S+)/g)].map((match) => [match[1] ?? '', match[2] ?? '']);
}

/**
 * The arguments passed to scripts/convert-template.mjs. The converter takes EVERY argument as a stack name
 * (`process.argv.slice(2)`), so nothing is filtered out: a stray flag here is a misconfiguration the test must report.
 */
function convertedStacks(command: string): string[] {
  const convert = commandsOf(command).find((part) => part.startsWith('node scripts/convert-template.mjs')) ?? '';
  return convert.split(/\s+/).slice(2);
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

  it('reserves no Lambda concurrency, which a workshop account cannot spare', () => {
    // Workshop Studio accounts had 110 unreserved executions (limit 1000), and AWS keeps at least 100 unreserved, so
    // the MCP endpoint's default reservation of 20 failed VocApiStack ("decreases account's
    // UnreservedConcurrentExecution below its minimum value of [100]"). Without one, the endpoint shares the pool;
    // its API Gateway stage throttle (20 rps, burst 40) bounds the request rate, not the concurrency
    // (lib/stacks/global-mcp.ts). That 0 omits the property rather than throttling the function to zero is pinned by
    // lib/stacks/api-stack-mcp-global-ops.test.ts ("never a throttling 0"), which also pins the default 20. Exactly
    // once, like protectData: a later -c mcpReservedConcurrency=<n> would win and bring the failure back.
    expect(synthContext(script).filter(([key]) => key === 'mcpReservedConcurrency'))
      .toStrictEqual([['mcpReservedConcurrency', '0']]);
  });

  it('keeps web search on and the model pin the workshop accounts are granted', () => {
    expect(synthContext(script)).toContainEqual(['enableWebSearch', 'true']);
    expect(synthContext(script)).toContainEqual(['defaultModelId', 'global.anthropic.claude-sonnet-4-6']);
  });

  it('converts exactly the five stacks, in deploy order', () => {
    expect(convertedStacks(script)).toStrictEqual(WORKSHOP_STACKS);
  });
});

// Unit tests of the parsers above, on fixed strings rather than the repository's script.
describe('synthContext', () => {
  it('reads both the -c and the --context form', () => {
    expect(synthContext('npx cdk synth -c a=1 --context protectData=true --context=b=2')).toStrictEqual([
      ['a', '1'],
      ['protectData', 'true'],
      ['b', '2'],
    ]);
  });

  it('reads the synth command only, never the converter that follows it', () => {
    expect(synthContext('npx cdk synth -c protectData=false && node convert.mjs -c protectData=true')).toStrictEqual([
      ['protectData', 'false'],
    ]);
  });
});

describe('convertedStacks', () => {
  it('returns every converter argument, so a stray flag fails the five-stacks check', () => {
    expect(convertedStacks('npx cdk synth && node scripts/convert-template.mjs --verbose A B')).toStrictEqual(['--verbose', 'A', 'B']);
  });
});
