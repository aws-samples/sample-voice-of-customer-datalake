/**
 * Tests never ship in a Python Lambda bundle (deadpy.md §5), and its bytecode is compiled at build time.
 *
 * The staging excludes shape only the asset hash: Docker bundling mounts the
 * unfiltered source as /asset-input, so `cp -r /asset-input/shared` used to copy
 * `shared/test/**` and `__pycache__/` into every deployed zip. Two checks:
 *
 * 1. Every Python bundling command any stack hands to `Code.fromAsset` ends with
 *    PYTHON_BUNDLE_PRUNE. Recorded from real in-process synths (the template
 *    holds no bundling command), so a site that bypasses the helper fails too.
 * 2. A real Docker build of one production bundle contains no test file and no
 *    `.pyc` from the source tree, and holds an unchecked-hash `cpython-314` `.pyc`
 *    next to every shipped module (no compile at cold start). Skipped when Docker or
 *    the bundling image is not available locally (it never pulls the multi-GB image).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { VocApiStack } from '../stacks/api-stack';
import { pluginDirectoryIds } from '../plugin-loader';
import { apiStackDependencyProps, pkSkTable } from '../test-support/api-stack-fixture';
import { synthIngestionStacks } from '../test-support/ingestion-stack-fixture';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_ACCOUNT, SYNTH_REGION } from '../test-support/synth-app';
import { PYTHON_BUNDLE_COMPILE, PYTHON_BUNDLE_PRUNE, pythonBundleScript } from './python-lambda-asset';
import { createWorkerFunction, workerRole } from './worker-lambda';

const PYTHON_IMAGE = lambda.Runtime.PYTHON_3_14.bundlingImage;
const PLUGIN_IDS = pluginDirectoryIds(join(process.cwd(), 'plugins'));

/**
 * The `bash -c` script of every Python-image FUNCTION bundle created while
 * `build` runs: those that copy source from /asset-input. The pip layer bundles
 * (python-layer-bundling.ts) are left out on purpose: their `.pyc` files are
 * compiled by the 3.14 image for the 3.14 runtime (a cold-start win), and a
 * third-party package may import its own `tests` module.
 */
function recordPythonBundleScripts(build: () => void): string[] {
  const scripts: string[] = [];
  const original = lambda.Code.fromAsset.bind(lambda.Code);
  const spy = vi.spyOn(lambda.Code, 'fromAsset').mockImplementation((assetPath, options) => {
    const bundling = options?.bundling;
    const script = bundling?.command?.at(-1) ?? '';
    if (bundling?.image === PYTHON_IMAGE && script.includes('/asset-input/')) scripts.push(script);
    return original(assetPath, options);
  });
  try {
    build();
  } finally {
    spy.mockRestore();
  }
  return scripts;
}

function synthApiStack(): void {
  const env = { account: SYNTH_ACCOUNT, region: SYNTH_REGION };
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], skipFrontendBuildCheck: true } });
  const deps = new cdk.Stack(app, 'Deps', { env });
  const stack = new VocApiStack(app, 'Api', {
    env,
    ...apiStackDependencyProps(deps, env, (id) => pkSkTable(deps, id)),
    brandName: 'Example Air',
    enabledSources: PLUGIN_IDS,
  });
  Template.fromStack(stack);
}

describe('every Python bundle prunes tests and stale caches, then compiles its bytecode', () => {
  const scripts = recordPythonBundleScripts(() => {
    synthProcessingTemplate();
    synthIngestionStacks(PLUGIN_IDS, { inboundEmailDomain: 'voc.example.com' });
    synthApiStack();
  });

  it('ends every recorded bundling script with the prune, then the compile', () => {
    const wrongEnd = scripts.filter((script) => !script.endsWith(` && ${PYTHON_BUNDLE_PRUNE} && ${PYTHON_BUNDLE_COMPILE}`));
    expect(wrongEnd).toStrictEqual([]);
  });

  it.each([
    ['an API handler', '/asset-input/api/metrics_handler.py'],
    ['an async job', '/asset-input/jobs/document_generator/handler.py'],
    ['the processor', '/asset-input/processor/'],
    ['the aggregator', '/asset-input/aggregator/'],
    ['the research step', '/asset-input/research/'],
    ['the category reprocess worker', '/asset-input/jobs/category_reprocess/'],
    ['the retention worker', '/asset-input/jobs/retention'],
    ['the Radar scan worker', '/asset-input/jobs/radar_scan'],
    ['a memory worker', '/asset-input/memory'],
    ['a plugin ingestor', '/asset-input/plugins/webscraper/ingestor/'],
    ['the email inbox worker', '/asset-input/email_intake'],
    ['the design capture worker', '/asset-input/lambda/design_capture/'],
  ])('covers %s (anti-vacuous)', (_label, copied) => {
    expect(scripts.some((script) => script.includes(copied))).toBe(true);
  });
});

describe('PYTHON_BUNDLE_PRUNE and PYTHON_BUNDLE_COMPILE', () => {
  it('run after the copy steps, prune first, joined into one fail-fast script', () => {
    expect(pythonBundleScript(['mkdir -p /asset-output', 'cp a b']))
      .toBe(`mkdir -p /asset-output && cp a b && ${PYTHON_BUNDLE_PRUNE} && ${PYTHON_BUNDLE_COMPILE}`);
  });

  it('compiles unchecked-hash bytecode over the whole output with the image\'s own Python', () => {
    expect(PYTHON_BUNDLE_COMPILE).toBe('python -m compileall -q -j 0 --invalidation-mode unchecked-hash /asset-output');
  });
});

/** Docker from a fixed location (CDK_DOCKER, CDK's own override, first), never a PATH lookup. */
function dockerCli(): string | undefined {
  const candidates = [process.env.CDK_DOCKER, '/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'];
  return candidates.find((path): path is string => path !== undefined && path.startsWith('/') && existsSync(path));
}

/** True when Docker runs and already holds the bundling image (no pull in a test). */
function bundlingImageAvailable(): boolean {
  const docker = dockerCli();
  if (docker === undefined) return false;
  try {
    execFileSync(docker, ['image', 'inspect', PYTHON_IMAGE.image], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Every path under `dir`, relative to it. */
function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [`${relative}/`, ...walk(join(dir, entry.name), relative)] : [relative];
  });
}

const SHIPPED_DIRECTORY = /(^|\/)(test|tests|\.pytest_cache)\/$/;
const SHIPPED_FILE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py)$/;
const isTest = (path: string): boolean => SHIPPED_DIRECTORY.test(path) || SHIPPED_FILE.test(path);

/** The `.py` a `<dir>/__pycache__/<name>.cpython-314.pyc` compiles; undefined for any other path. */
function sourceOf(pyc: string): string | undefined {
  const parts = pyc.split('/');
  const file = parts.at(-1) ?? '';
  if (parts.at(-2) !== '__pycache__' || !file.endsWith(PYC_SUFFIX)) return undefined;
  return [...parts.slice(0, -2), `${file.slice(0, -PYC_SUFFIX.length)}.py`].join('/');
}
const PYC_SUFFIX = '.cpython-314.pyc';

/** PEP 552 flags word of a .pyc (bytes 4-7): 0b01 = hash-based, not checked against the source. */
const pycFlags = (file: string): number => readFileSync(file).readUInt32LE(4);

describe.skipIf(!bundlingImageAvailable())('a real Docker-built bundle (briefing worker)', () => {
  const outdir = mkdtempSync(join(tmpdir(), 'voc-python-bundle-'));
  let asset = '';
  let files: string[] = [];
  afterAll(() => rmSync(outdir, { recursive: true, force: true }));

  /** Synthesizes with real Docker bundling; returns the one asset directory. */
  function bundleBriefingWorker(): string {
    const app = new cdk.App({ outdir });
    const stack = new cdk.Stack(app, 'BundleProbe', { env: { account: SYNTH_ACCOUNT, region: SYNTH_REGION } });
    createWorkerFunction(stack, 'Probe', {
      tree: 'briefing',
      functionName: 'voc-bundle-probe',
      handler: 'briefing/handler.lambda_handler',
      role: workerRole(stack, 'ProbeRole'),
      layer: lambda.LayerVersion.fromLayerVersionArn(stack, 'Layer', `arn:aws:lambda:${SYNTH_REGION}:${SYNTH_ACCOUNT}:layer:probe:1`),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {},
      serviceName: 'voc-bundle-probe',
    });
    app.synth();
    const assetDirs = readdirSync(outdir).filter((name) => name.startsWith('asset.'));
    if (assetDirs.length !== 1) throw new Error(`expected one asset directory, got ${assetDirs.join(', ')}`);
    return join(outdir, assetDirs[0] ?? '');
  }

  beforeAll(() => {
    // A cache file in the source tree, the shape a developer checkout always has
    // (a fresh clone has none, which would make the stale-cache case vacuous).
    const cacheDir = join(process.cwd(), 'lambda', 'shared', '__pycache__');
    const createdCacheDir = !existsSync(cacheDir);
    mkdirSync(cacheDir, { recursive: true });
    const cacheFile = join(cacheDir, 'python-lambda-asset-probe.cpython-314.pyc');
    writeFileSync(cacheFile, '');
    try {
      asset = bundleBriefingWorker();
      files = walk(asset);
    } finally {
      rmSync(createdCacheDir ? cacheDir : cacheFile, { recursive: true, force: true });
    }
  }, 300_000);

  it('contains the payload and no test file', () => {
    expect(files).toContain('briefing/handler.py');
    expect(files).toContain('shared/api.py');
    expect(files.filter(isTest)).toStrictEqual([]);
  });

  it('ships no .pyc from the source tree (the probe has no .py, so only a stale copy could be there)', () => {
    expect(files.filter((path) => path.includes('python-lambda-asset-probe'))).toStrictEqual([]);
  });

  it('holds a cpython-314 .pyc for every shipped module, and none without its module', () => {
    const modules = files.filter((path) => path.endsWith('.py'));
    const compiled = files.filter((path) => path.endsWith('.pyc'));
    expect(compiled.map(sourceOf).filter((source) => source === undefined || !modules.includes(source))).toStrictEqual([]);
    expect(modules.filter((module) => !compiled.some((pyc) => sourceOf(pyc) === module))).toStrictEqual([]);
  });

  it('compiles unchecked-hash bytecode (PEP 552 flags = 1) everywhere', () => {
    const compiled = files.filter((path) => path.endsWith('.pyc'));
    expect(new Set(compiled.map((pyc) => pycFlags(join(asset, pyc))))).toStrictEqual(new Set([1]));
  });
});
