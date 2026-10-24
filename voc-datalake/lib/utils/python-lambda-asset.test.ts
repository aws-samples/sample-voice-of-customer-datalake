/**
 * Tests and caches never ship in a Python Lambda bundle (deadpy.md §5).
 *
 * The staging excludes shape only the asset hash: Docker bundling mounts the
 * unfiltered source as /asset-input, so `cp -r /asset-input/shared` used to copy
 * `shared/test/**` and `__pycache__/` into every deployed zip. Two checks:
 *
 * 1. Every Python bundling command any stack hands to `Code.fromAsset` ends with
 *    PYTHON_BUNDLE_PRUNE. Recorded from real in-process synths (the template
 *    holds no bundling command), so a site that bypasses the helper fails too.
 * 2. A real Docker build of one production bundle contains no test file, no
 *    `__pycache__` and no `.pyc`. Skipped when Docker or the bundling image is
 *    not available locally (it never pulls the multi-GB image).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { VocApiStack } from '../stacks/api-stack';
import { pluginDirectoryIds } from '../plugin-loader';
import { apiStackDependencyProps, pkSkTable } from '../test-support/api-stack-fixture';
import { synthIngestionStacks } from '../test-support/ingestion-stack-fixture';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_ACCOUNT, SYNTH_REGION } from '../test-support/synth-app';
import { PYTHON_BUNDLE_PRUNE, pythonBundleScript } from './python-lambda-asset';
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

describe('every Python bundle prunes tests and caches from its output', () => {
  const scripts = recordPythonBundleScripts(() => {
    synthProcessingTemplate();
    synthIngestionStacks(PLUGIN_IDS, { inboundEmailDomain: 'voc.example.com' });
    synthApiStack();
  });

  it('ends every recorded bundling script with the prune', () => {
    const unpruned = scripts.filter((script) => !script.endsWith(` && ${PYTHON_BUNDLE_PRUNE}`));
    expect(unpruned).toStrictEqual([]);
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

describe('PYTHON_BUNDLE_PRUNE', () => {
  it('runs after the copy steps, joined into one fail-fast script', () => {
    expect(pythonBundleScript(['mkdir -p /asset-output', 'cp a b']))
      .toBe(`mkdir -p /asset-output && cp a b && ${PYTHON_BUNDLE_PRUNE}`);
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

const SHIPPED_DIRECTORY = /(^|\/)(test|tests|__pycache__|\.pytest_cache)\/$/;
const SHIPPED_FILE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py|[^/]*\.pyc)$/;
const isTestOrCache = (path: string): boolean => SHIPPED_DIRECTORY.test(path) || SHIPPED_FILE.test(path);

describe.skipIf(!bundlingImageAvailable())('a real Docker-built bundle (briefing worker)', () => {
  const outdir = mkdtempSync(join(tmpdir(), 'voc-python-bundle-'));
  afterAll(() => rmSync(outdir, { recursive: true, force: true }));

  /** Synthesizes with real Docker bundling; returns the one asset directory's paths. */
  function bundleBriefingWorker(): string[] {
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
    expect(assetDirs).toHaveLength(1);
    return walk(join(outdir, assetDirs[0] ?? ''));
  }

  it('contains the payload and no test file, __pycache__ or .pyc', () => {
    // A cache file in the source tree, the shape a developer checkout always has
    // (a fresh clone has none, which would make the cache half of this vacuous).
    const cacheDir = join(process.cwd(), 'lambda', 'shared', '__pycache__');
    const createdCacheDir = !existsSync(cacheDir);
    mkdirSync(cacheDir, { recursive: true });
    const cacheFile = join(cacheDir, 'python-lambda-asset-probe.cpython-314.pyc');
    writeFileSync(cacheFile, '');
    try {
      const files = bundleBriefingWorker();
      expect(files).toContain('briefing/handler.py');
      expect(files).toContain('shared/api.py');
      expect(files.filter(isTestOrCache)).toStrictEqual([]);
    } finally {
      rmSync(createdCacheDir ? cacheDir : cacheFile, { recursive: true, force: true });
    }
  }, 300_000);
});
