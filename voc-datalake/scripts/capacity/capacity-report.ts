/**
 * Read-only capacity report for every deployed `voc-*` Lambda under the sizing
 * policy (lib/sizing/policy.ts, docs/lambda-sizing.md).
 *
 *   npx ts-node scripts/capacity/capacity-report.ts [--hours 168] [--region us-west-2] [--json out.json] [--repo-sizes]
 *
 * Prints a Markdown table, the unmeasured functions and the by-design exceptions;
 * exits 1 when any function breaches the rule, 2 on a usage or AWS error. Uses the
 * operator's ambient AWS credentials for `lambda list-functions`,
 * `logs describe-log-groups` and Logs Insights queries only — nothing is written.
 *
 * `--repo-sizes` judges each function at the MemorySize this checkout would deploy
 * (MEMORY_SIZES) instead of the deployed one, projecting the measurement (use it
 * before a release that resizes functions is deployed).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

import { breaches, collectCapacity, renderReport, type AwsRunner } from '../../lib/sizing/capacity';
import { MEMORY_SIZES } from '../../lib/sizing/policy';

interface Args {
  hours: number;
  region: string;
  json: string | undefined;
  repoSizes: boolean;
}

const DEFAULT_ARGS: Args = { hours: 168, region: process.env.AWS_REGION ?? 'us-west-2', json: undefined, repoSizes: false };

/** Value-taking flags: how each validates and stores its value. */
const VALUE_FLAGS: Readonly<Record<string, (args: Args, value: string) => boolean>> = {
  '--hours': (args, value) => {
    args.hours = Number(value);
    return /^\d+$/.test(value) && args.hours >= 1 && args.hours <= 24 * 30;
  },
  '--region': (args, value) => {
    args.region = value;
    return /^[a-z]{2}(-[a-z]+)+-\d$/.test(value);
  },
  '--json': (args, value) => {
    args.json = value;
    return value !== '';
  },
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { ...DEFAULT_ARGS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (flag === '--repo-sizes') {
      args.repoSizes = true;
      continue;
    }
    const apply = VALUE_FLAGS[flag];
    const value = argv[i + 1];
    if (apply === undefined || value === undefined || !apply(args, value)) {
      throw new Error(`unknown or invalid argument: ${flag} (--hours 1..720, --region, --json <file>, --repo-sizes)`);
    }
    i += 1;
  }
  return args;
}

/** The AWS CLI from a fixed location (AWS_CLI overrides), never a PATH lookup. */
function awsCli(): string {
  const candidates = [process.env.AWS_CLI, '/opt/homebrew/bin/aws', '/usr/local/bin/aws', '/usr/bin/aws'];
  const found = candidates.find((path): path is string => path !== undefined && path.startsWith('/') && existsSync(path));
  if (found === undefined) throw new Error('AWS CLI not found; set AWS_CLI to its absolute path');
  return found;
}

function cliRunner(region: string): AwsRunner {
  const cli = awsCli();
  return (args) => {
    const out = execFileSync(cli, [...args, '--region', region, '--output', 'json'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() === '' ? null : JSON.parse(out);
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const endSec = Math.floor(Date.now() / 1000);
  const report = await collectCapacity(cliRunner(args.region), {
    startSec: endSec - args.hours * 3600,
    endSec,
    ...(args.repoSizes ? { targetSizes: MEMORY_SIZES } : {}),
  });
  const window = `${new Date(report.window.startSec * 1000).toISOString()} → ${new Date(report.window.endSec * 1000).toISOString()}`;
  console.log(`Capacity, ${args.region}, ${window}${args.repoSizes ? ' (judged at this checkout\'s sizes)' : ''}\n`);
  console.log(renderReport(report));
  if (args.json !== undefined) writeFileSync(args.json, JSON.stringify(report, null, 2));
  const over = breaches(report);
  console.log(over.length === 0 ? '\nNo breach.' : `\n${over.length} breach(es): ${over.map((f) => f.stem).join(', ')}`);
  return over.length === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (err: unknown) => {
  console.error(`capacity-report: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
});
