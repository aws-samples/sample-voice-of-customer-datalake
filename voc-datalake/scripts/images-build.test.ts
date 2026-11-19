/**
 * scripts/images-build.mjs (`npm run images:build -- <language> <tag> [--push] [--dry-run]`, 7.56.00): the documented
 * `docker buildx` command, a local image unless --push, and --push held to the caller's account and the stack's output.
 * The script runs in a child process whose PATH holds only fake `aws` and `docker` (they log their arguments and answer
 * canned text) and node, so no test ever reaches a real Docker or AWS.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, 'images-build.mjs');
const CONTEXT = path.resolve(__dirname, '..');
const ACCOUNT = '123456789012';
const URI = `${ACCOUNT}.dkr.ecr.us-west-2.amazonaws.com/b-voc-eng-python-${ACCOUNT}-us-west-2`;
const PUSHED = `${URI}:7.56.0`;
const SHA = '213db1c79ee03e4d83d213632e3de3b0c59cf5ad8f67869ef6347a722a03fba0';
const DEFAULT_ARGS = ['--build-arg', 'MOUNTPOINT_VERSION=1.25.0', '--build-arg', `MOUNTPOINT_SHA256=${SHA}`,
  '--build-arg', 'BOTO3_VERSION=1.43.124'];

/** A fake CLI: logs `<name> <args>` (and docker its working directory), answers by its first two words. */
const FAKE_AWS = `#!/bin/sh
echo "aws $*" >> "$FAKE_LOG"
case "$1 $2" in
  "sts get-caller-identity") printf '{"Account": "%s"}' "$FAKE_ACCOUNT" ;;
  "cloudformation describe-stacks") printf '%s' "$FAKE_OUTPUTS" ;;
  "ecr get-login-password") printf 'the-registry-password' ;;
  "ecr describe-images") printf 'sha256:%s\\n' "$FAKE_DIGEST" ;;
esac
`;
const FAKE_DOCKER = `#!/bin/sh
echo "docker $* @ $(pwd)" >> "$FAKE_LOG"
if [ "$1" = login ]; then /bin/cat > "$FAKE_LOG.stdin"; fi
exit "\${FAKE_DOCKER_EXIT:-0}"
`;

let fakes: string;

beforeEach(() => {
  fakes = mkdtempSync(path.join(os.tmpdir(), 'images-build-'));
  for (const [name, text] of [['aws', FAKE_AWS], ['docker', FAKE_DOCKER]] as const) {
    writeFileSync(path.join(fakes, name), text);
    chmodSync(path.join(fakes, name), 0o755);
  }
});

afterEach(() => rmSync(fakes, { recursive: true, force: true }));

function outputs(value: string = URI): string {
  return JSON.stringify([{ OutputKey: 'EngineeringImageRepositoryNode', OutputValue: 'x' },
    { OutputKey: 'EngineeringImageRepositoryPython', OutputValue: value }]);
}

/** The script with `args` and `env` (only the fakes and node on PATH): its exit code, its output and the fakes' log. */
function images(args: string[], env: Record<string, string> = {}) {
  const log = path.join(fakes, 'calls.log');
  const done = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: `${fakes}${path.delimiter}${path.dirname(process.execPath)}`, FAKE_LOG: log, FAKE_ACCOUNT: ACCOUNT,
      FAKE_OUTPUTS: outputs(), FAKE_DIGEST: 'f'.repeat(64), ...env },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  const stdin = existsSync(`${log}.stdin`) ? readFileSync(`${log}.stdin`, 'utf8') : null;
  return { code: done.status, out: done.stdout, err: done.stderr, calls, stdin };
}

const build = (ref: string, mode: string, args: string[] = DEFAULT_ARGS) => ['docker', 'buildx', 'build', '--platform',
  'linux/arm64', '-f', 'templates/orchestration/images/python/Dockerfile', ...args, '-t', ref, mode, '.'].join(' ');

describe('images:build arguments', () => {
  it.each([
    [[], /usage: npm run images:build/],
    [['python'], /usage: npm run images:build/],
    [['python', 'v1', 'extra'], /usage: npm run images:build/],
    [['cobol', 'v1'], /no image for cobol: one of java, node, python, rust/],
    [['python', 'latest'], /never latest/],
    [['python', '-bad'], /unknown option -bad|not a new image tag/],
    [['python', 'a/b'], /not a new image tag/],
    [['python', 'v1', '--force'], /unknown option --force/],
  ])('refuses %j with exit 2 and runs nothing', (args, message) => {
    const result = images(args);
    expect([result.code, result.calls]).toStrictEqual([2, []]);
    expect(result.err).toMatch(message);
  });

  it('refuses a build argument of the wrong shape from the environment', () => {
    const result = images(['python', 'v1'], { MOUNTPOINT_SHA256: 'not-a-sha' });
    expect([result.code, result.calls]).toStrictEqual([2, []]);
    expect(result.err).toMatch(/MOUNTPOINT_SHA256=not-a-sha is not the shape it takes/);
  });
});

describe('images:build without --push: a local image only', () => {
  it('runs the documented docker buildx command from voc-datalake/, loaded as voc-eng-<language>:<tag>, no AWS call', () => {
    const result = images(['python', 'local-7.56']);
    expect(result.code).toBe(0);
    expect(result.calls).toStrictEqual([`${build('voc-eng-python:local-7.56', '--load')} @ ${CONTEXT}`]);
    expect(result.out).toMatch(/built voc-eng-python:local-7.56 \(local only: nothing was pushed\)/);
  });

  it('takes each build argument from the environment when it is set', () => {
    const result = images(['rust', 'v9'], { MOUNTPOINT_VERSION: '1.26.0', BOTO3_VERSION: '1.44.0' });
    expect(result.code).toBe(0);
    expect(result.calls[0]).toContain('-f templates/orchestration/images/rust/Dockerfile --build-arg '
      + `MOUNTPOINT_VERSION=1.26.0 --build-arg MOUNTPOINT_SHA256=${SHA} --build-arg BOTO3_VERSION=1.44.0 `
      + '-t voc-eng-rust:v9 --load .');
  });

  it('exits 1 when the build fails', () => {
    const result = images(['python', 'v1'], { FAKE_DOCKER_EXIT: '3' });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/docker buildx build exited 3/);
  });

  it('prints the command and runs nothing with --dry-run', () => {
    const result = images(['python', 'v1', '--dry-run']);
    expect([result.code, result.calls]).toStrictEqual([0, []]);
    expect(result.out.trim()).toBe(build('voc-eng-python:v1', '--load'));
  });
});

describe('images:build --push', () => {
  it('refuses without AWS_PROFILE, before any call', () => {
    const result = images(['python', 'v1', '--push']);
    expect([result.code, result.calls]).toStrictEqual([2, []]);
    expect(result.err).toMatch(/--push takes the account from AWS_PROFILE: set it/);
  });

  it('pushes to the repository the stack output names, the password on docker\'s stdin, and prints the digest', () => {
    const result = images(['python', '7.56.0', '--push'], { AWS_PROFILE: 'test-profile' });
    expect(result.code).toBe(0);
    expect(result.calls).toStrictEqual([
      'aws sts get-caller-identity --output json',
      'aws cloudformation describe-stacks --stack-name VocProcessingStack --query Stacks[0].Outputs --output json',
      'aws ecr get-login-password --region us-west-2',
      `docker login --username AWS --password-stdin ${ACCOUNT}.dkr.ecr.us-west-2.amazonaws.com @ ${CONTEXT}`,
      `${build(PUSHED, '--push')} @ ${CONTEXT}`,
      `aws ecr describe-images --region us-west-2 --repository-name b-voc-eng-python-${ACCOUNT}-us-west-2 --image-ids `
        + 'imageTag=7.56.0 --query imageDetails[0].imageDigest --output text',
    ]);
    // (the registry's password reaches docker on its stdin, never in an argv the log shows)
    expect([result.stdin, result.calls.join('\n').includes('the-registry-password')])
      .toStrictEqual(['the-registry-password', false]);
    expect(result.out).toContain(`pushed ${PUSHED} sha256:${'f'.repeat(64)}`);
  });

  it('reads a prefixed deployment\'s stack from PROCESSING_STACK', () => {
    const result = images(['python', 'v1', '--push'], { AWS_PROFILE: 'p', PROCESSING_STACK: 'b-VocProcessingStack' });
    expect(result.code).toBe(0);
    expect(result.calls[1]).toContain('--stack-name b-VocProcessingStack');
  });

  it('refuses a repository of another account than the caller\'s, before Docker logs in', () => {
    const result = images(['python', 'v1', '--push'], { AWS_PROFILE: 'p', FAKE_ACCOUNT: '999999999999' });
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/a repository of account 123456789012, and AWS_PROFILE is account 999999999999: refused/);
    expect(result.calls.filter((call) => call.startsWith('docker'))).toStrictEqual([]);
  });

  it('refuses a stack without the language\'s output, or an output that is not an ECR repository', () => {
    const missing = images(['java', 'v1', '--push'], { AWS_PROFILE: 'p' });
    const odd = images(['python', 'v1', '--push'], { AWS_PROFILE: 'p', FAKE_OUTPUTS: outputs('example.com/x') });
    expect([missing.code, odd.code]).toStrictEqual([2, 2]);
    expect(missing.err).toMatch(/VocProcessingStack has no output EngineeringImageRepositoryJava/);
    expect(odd.err).toMatch(/EngineeringImageRepositoryPython is not an ECR repository URI/);
    expect([...missing.calls, ...odd.calls].filter((call) => call.startsWith('docker'))).toStrictEqual([]);
  });

  it('prints every command and runs none with --dry-run', () => {
    const result = images(['python', 'v1', '--push', '--dry-run'], { AWS_PROFILE: 'p' });
    expect([result.code, result.calls]).toStrictEqual([0, []]);
    expect(result.out).toContain(build('<EngineeringImageRepositoryPython>:v1', '--push'));
    expect(result.out).toContain('aws cloudformation describe-stacks --stack-name VocProcessingStack');
  });
});
