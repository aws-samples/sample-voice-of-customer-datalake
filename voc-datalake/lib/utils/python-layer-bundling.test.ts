/**
 * Regression + drift guard for the shared Python layer bundling recipe
 * (issue #194).
 *
 * The recipe intentionally exists in two places — pythonLayerCode() for CDK
 * synth-time bundling and scripts/build-layers.sh for manual builds. These
 * tests fail if either copy loses one of the load-bearing pieces (throwaway
 * venv, boto3/botocore strip, quiet flags) or if the two copies drift apart,
 * and they enforce the "no inline pip install in stacks" rule the helper's
 * doc comment promises.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { pythonLayerCode } from './python-layer-bundling';

// AssetCode keeps its constructor args in TypeScript-private fields, which
// still exist at runtime; parse them with Zod instead of reaching in with
// type assertions.
const assetCodeSchema = z.object({
  path: z.string(),
  options: z.object({
    exclude: z.array(z.string()),
    bundling: z.object({
      platform: z.string(),
      command: z.array(z.string()),
    }),
  }),
});

function parseLayerCode(layerDir: string): z.infer<typeof assetCodeSchema> {
  return assetCodeSchema.parse(pythonLayerCode(layerDir));
}

// The pieces of the recipe that fix issue #194. If any of these disappears,
// the mismatched-botocore bug or the build noise comes back.
const REQUIRED_RECIPE_TOKENS = [
  'python -m venv',              // throwaway venv: kills pip's resolver ERROR
  '--quiet',
  '--no-cache-dir',              // kills the unwritable ~/.cache WARNING
  '--root-user-action=ignore',   // kills the root-user WARNING
  '--disable-pip-version-check', // kills the self-update notice
];

describe('pythonLayerCode', () => {
  const parsed = parseLayerCode('lambda/layers/processing-deps');
  const command = parsed.options.bundling.command.join(' ');

  it('targets ARM64 and installs from requirements.txt via a throwaway venv', () => {
    expect(parsed.options.bundling.platform).toBe('linux/arm64');
    expect(command).toContain('/tmp/buildenv/bin/pip install -r requirements.txt');
    for (const token of REQUIRED_RECIPE_TOKENS) {
      expect(command).toContain(token);
    }
  });

  it('strips boto3/botocore so the runtime-provided matched pair wins', () => {
    expect(command).toMatch(/rm -rf [^&]*\/python\/boto3 /);
    expect(command).toContain('/python/botocore');
    expect(command).toContain('/python/boto3-*');
    expect(command).toContain('/python/botocore-*');
  });

  it('excludes local build output so deploys never ship a stale nested copy', () => {
    expect(parsed.options.exclude).toContain('python');
    expect(parsed.options.exclude).toContain('**/.DS_Store');
  });
});

describe('lockstep with scripts/build-layers.sh', () => {
  const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'build-layers.sh'), 'utf8');

  it('manual builds use the same venv + flags recipe', () => {
    for (const token of [...REQUIRED_RECIPE_TOKENS, '/tmp/buildenv/bin/pip install']) {
      expect(script).toContain(token);
    }
  });

  it('manual builds strip boto3/botocore too', () => {
    expect(script).toMatch(/rm -rf [^"]*\/python\/boto3 /);
    expect(script).toContain('/python/botocore');
    expect(script).toContain('/python/boto3-*');
    expect(script).toContain('/python/botocore-*');
  });
});

describe('layer source dirs', () => {
  // pythonLayerCode() deploys ONLY pip-installed dependencies. Anything else
  // placed in a layer dir would silently not ship — fail loudly instead.
  const allowedEntries = new Set(['requirements.txt', 'python', 'README.md', '.DS_Store']);
  const layersRoot = path.join(process.cwd(), 'lambda', 'layers');

  for (const layerDir of fs.readdirSync(layersRoot).filter((entry) => !entry.startsWith('.'))) {
    it(`${layerDir} contains no first-party files that would silently not deploy`, () => {
      const entries = fs.readdirSync(path.join(layersRoot, layerDir));
      const unexpected = entries.filter((entry) => !allowedEntries.has(entry));
      expect(unexpected).toEqual([]);
    });
  }
});

describe('stacks use the shared helper', () => {
  it('no stack defines an inline pip install', () => {
    const stacksDir = path.join(process.cwd(), 'lib', 'stacks');
    const offenders = fs.readdirSync(stacksDir)
      // Non-test sources only, matching lambda-asset-excludes.test.ts — a
      // stack test may legitimately mention "pip install" in a string.
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) => fs.readFileSync(path.join(stacksDir, file), 'utf8').includes('pip install'));
    expect(offenders).toEqual([]);
  });
});
