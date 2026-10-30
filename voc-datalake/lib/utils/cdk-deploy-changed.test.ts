/**
 * scripts/cdk-deploy.sh with CDK_DEPLOY_CHANGED=1 (H7): deploy only the stacks `cdk diff` reports,
 * refresh the API stage whenever VocApiStack is among them, and fall back to the full deploy (with
 * the refresh) whenever the diff fails or cannot be read. The default mode stays the full deploy.
 *
 * The real script runs with fake `npx` and `aws` first on PATH: the fake npx prints a canned
 * `cdk diff` and records every deploy, the fake aws answers refresh-api-stage.sh's two calls.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CDK_DEPLOY_SH = join(__dirname, '..', '..', 'scripts', 'cdk-deploy.sh');

const FAKE_NPX = `#!/bin/bash
echo "npx $*" >> "$FAKE_LOG"
if [ "$2" = "diff" ]; then cat "$FAKE_DIFF"; exit "\${FAKE_DIFF_STATUS:-0}"; fi
`;
const FAKE_AWS = `#!/bin/bash
echo "aws $1 $2" >> "$FAKE_LOG"
case "$*" in
  *ApiId*) echo abc123 ;;
  *ApiEndpoint*) echo https://abc123.execute-api.us-east-1.amazonaws.com/v1/ ;;
  *create-deployment*) echo dep1 ;;
esac
`;

const unchanged = (name: string) => `Stack ${name}\nThere were no differences\n`;
const changed = (name: string) => `Stack ${name}\nResources\n[~] AWS::Lambda::Function Fn Fn1234\n`;
const summary = (n: number) => `\n✨  Number of stacks with differences: ${n}\n`;

let root: string;
let log: string;
let diff: string;

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** Runs cdk-deploy.sh; returns the recorded `npx ...` / `aws ...` calls. */
function deploy(args: string[], env: Record<string, string> = {}): string[] {
  execFileSync('/bin/bash', [CDK_DEPLOY_SH, ...args], {
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_LOG: log,
      FAKE_DIFF: diff,
      CDK_DEPLOY_CHANGED: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
}

const REFRESH = ['aws cloudformation describe-stacks', 'aws cloudformation describe-stacks', 'aws apigateway create-deployment'];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cdk-deploy-'));
  log = join(root, 'calls.log');
  diff = join(root, 'diff.txt');
  mkdirSync(join(root, 'bin'));
  writeExecutable(join(root, 'bin', 'npx'), FAKE_NPX);
  writeExecutable(join(root, 'bin', 'aws'), FAKE_AWS);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scripts/cdk-deploy.sh', () => {
  it('default mode: one full cdk deploy with the arguments as given, then the stage refresh', () => {
    writeFileSync(diff, '');
    expect(deploy(['--all', '-c', 'frontendDomain=x'])).toStrictEqual([
      'npx cdk deploy --all -c frontendDomain=x', ...REFRESH,
    ]);
  });

  it('changed mode: deploys exactly the changed stacks with --exclusively and refreshes for VocApiStack', () => {
    writeFileSync(diff, unchanged('VocWebSearchStack') + changed('VocCoreStack') + unchanged('VocIngestionStack')
      + unchanged('VocProcessingStack') + changed('VocApiStack') + summary(2));
    expect(deploy(['--all', '--require-approval', 'never', '-c', 'frontendDomain=x', '--context=protectData=true'],
      { CDK_DEPLOY_CHANGED: '1' })).toStrictEqual([
      'npx cdk diff --all -c frontendDomain=x --context=protectData=true',
      'npx cdk deploy --exclusively --require-approval never -c frontendDomain=x --context=protectData=true VocCoreStack VocApiStack',
      ...REFRESH,
    ]);
  });

  it('changed mode: skips the refresh when VocApiStack did not change', () => {
    writeFileSync(diff, changed('VocProcessingStack') + unchanged('VocApiStack') + summary(1));
    expect(deploy(['--all'], { CDK_DEPLOY_CHANGED: '1' })).toStrictEqual([
      'npx cdk diff --all', 'npx cdk deploy --exclusively VocProcessingStack',
    ]);
  });

  it('changed mode: a prefixed VocApiStack still gets the refresh', () => {
    writeFileSync(diff, changed('p-VocApiStack') + summary(1));
    expect(deploy(['--all', '-c', 'deploymentPrefix=p'], { CDK_DEPLOY_CHANGED: '1', API_STACK: 'p-VocApiStack' }))
      .toStrictEqual(['npx cdk diff --all -c deploymentPrefix=p', 'npx cdk deploy --exclusively -c deploymentPrefix=p p-VocApiStack', ...REFRESH]);
  });

  it('changed mode: deploys nothing when no stack has differences', () => {
    writeFileSync(diff, unchanged('VocCoreStack') + unchanged('VocApiStack') + summary(0));
    expect(deploy(['--all'], { CDK_DEPLOY_CHANGED: '1' })).toStrictEqual(['npx cdk diff --all']);
  });

  it.each([
    ['the diff cannot be read', 'unexpected output\n', '0'],
    ['cdk diff fails', changed('VocApiStack') + summary(1), '1'],
  ])('changed mode: falls back to the full deploy + refresh when %s', (_label, output, status) => {
    writeFileSync(diff, output);
    expect(deploy(['--all'], { CDK_DEPLOY_CHANGED: '1', FAKE_DIFF_STATUS: status })).toStrictEqual([
      'npx cdk diff --all', 'npx cdk deploy --all', ...REFRESH,
    ]);
  });

  it('changed mode: a failed deploy stops before the refresh', () => {
    writeFileSync(diff, changed('VocApiStack') + summary(1));
    writeExecutable(join(root, 'bin', 'npx'), `${FAKE_NPX}[ "$2" = "deploy" ] && exit 1\n`);
    expect(() => deploy(['--all'], { CDK_DEPLOY_CHANGED: '1' })).toThrow(/Command failed/);
    expect(readFileSync(log, 'utf8')).not.toContain('aws apigateway');
  });
});
