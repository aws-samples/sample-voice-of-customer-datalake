#!/usr/bin/env node
// Reads `cdk diff --all` output on stdin and prints the stacks that have differences, one per line,
// in the order the diff listed them. Used by scripts/cdk-deploy.sh in its opt-in CDK_DEPLOY_CHANGED=1
// mode (docs/deployment.md → "Deploy only the stacks that changed").
//
// Exit 0: the list is trustworthy (possibly empty). Exit 3: the output could not be read with
// certainty (no stack header, no "Number of stacks with differences" summary, or a summary that
// disagrees with the stacks found). cdk-deploy.sh then falls back to the full deploy, so a CDK
// output format change costs speed, never a skipped stack.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const UNSURE_EXIT_CODE = 3;

// eslint-disable-next-line no-control-regex -- ANSI colour codes are exactly what this strips
const ANSI = /\u001b\[[0-9;]*m/g;
const STACK_HEADER = /^Stack (\S+)/;
const NO_DIFFERENCES = /^There were no differences\b/;
const SUMMARY = /Number of stacks with differences: (\d+)/;

/**
 * @param {string} output raw `cdk diff` output (stdout + stderr, colours allowed)
 * @returns {{ sure: true, changed: string[] } | { sure: false, reason: string }}
 */
export function changedStacks(output) {
  const lines = output.replace(ANSI, '').split(/\r?\n/);
  /** @type {Array<{ name: string, unchanged: boolean }>} */
  const stacks = [];
  let summary = null;
  for (const line of lines) {
    const header = STACK_HEADER.exec(line);
    if (header) {
      stacks.push({ name: header[1], unchanged: false });
      continue;
    }
    const current = stacks.at(-1);
    if (current && NO_DIFFERENCES.test(line.trim())) current.unchanged = true;
    const total = SUMMARY.exec(line);
    if (total) summary = Number(total[1]);
  }
  if (stacks.length === 0) return { sure: false, reason: 'no "Stack <name>" header in the diff output' };
  if (summary === null) return { sure: false, reason: 'no "Number of stacks with differences" summary' };
  const changed = stacks.filter((s) => !s.unchanged).map((s) => s.name);
  if (new Set(changed).size !== changed.length) return { sure: false, reason: 'a stack header appears twice' };
  if (changed.length !== summary) {
    return { sure: false, reason: `found ${changed.length} changed stack(s), the summary says ${summary}` };
  }
  return { sure: true, changed };
}

function main() {
  const result = changedStacks(readFileSync(0, 'utf8'));
  if (!result.sure) {
    process.stderr.write(`cdk-changed-stacks: unsure (${result.reason})\n`);
    process.exit(UNSURE_EXIT_CODE);
  }
  if (result.changed.length > 0) process.stdout.write(`${result.changed.join('\n')}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
