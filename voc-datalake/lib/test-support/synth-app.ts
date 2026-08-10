/**
 * Test support: synthesize the WHOLE app (bin/voc-datalake.ts) out of process.
 *
 * The prefix tests have to exercise the real entrypoint, not a hand-assembled
 * stack graph: stack ids, cross-stack export names and the `deploymentPrefix`
 * context read all live in `bin/`, and a test that reconstructs them would
 * verify its own copy rather than what `cdk synth` produces.
 *
 * Not a `*.test.ts` file, so vitest's `include` never picks it up as a suite.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NameInventory } from './name-inventory';

const PROJECT_ROOT = join(__dirname, '..', '..');

/** Fixed synth environment, so a template hash depends only on the source. */
export const SYNTH_ACCOUNT = '111111111111';
export const SYNTH_REGION = 'us-east-1';

/** Committed fingerprint of the no-prefix synth, relative to the project root. */
export const BASELINE_PATH = 'lib/test-support/baseline.json';

/** Shape of {@link BASELINE_PATH}. Written by scripts/generate-baseline.ts. */
export interface Baseline {
  description: string;
  stacks: Record<string, { templateSha256: string; names: NameInventory }>;
}

/**
 * Context every synth here uses. Mirrors cdk.json + cdk.context.json (the
 * committed project defaults, i.e. what a real deploy gets) plus the two
 * escape hatches template assertions always want: no Docker bundling and no
 * frontend-freshness check.
 */
function baseContext(): Record<string, unknown> {
  const cdkJson: unknown = JSON.parse(readFileSync(join(PROJECT_ROOT, 'cdk.json'), 'utf8'));
  const committed: unknown = JSON.parse(readFileSync(join(PROJECT_ROOT, 'cdk.context.json'), 'utf8'));
  const featureFlags = isRecord(cdkJson) && isRecord(cdkJson.context) ? cdkJson.context : {};
  const projectContext = isRecord(committed) ? committed : {};
  return {
    ...featureFlags,
    ...projectContext,
    'aws:cdk:bundling-stacks': [],
    skipFrontendBuildCheck: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SynthResult {
  /** Absolute path to the cloud assembly directory. */
  outdir: string;
  /** Stack artifact ids present in the assembly, sorted. */
  stackNames: string[];
  /** Parsed template for one stack, by artifact id. */
  template(stackName: string): Record<string, unknown>;
  /**
   * Template text with every 64-hex asset hash replaced by `<ASSET_HASH>`.
   *
   * Asset hashes are digests of the Lambda SOURCE TREE, so they move whenever
   * any Python or frontend file changes — including changes that cannot affect
   * naming. Normalizing them keeps the byte-identity guard pointed at the
   * template structure it is actually asserting about.
   */
  canonicalTemplate(stackName: string): string;
  /** Everything cdk-nag and CDK reported: warnings, errors, info. */
  annotations: Array<{ stack: string; type: string; data: string }>;
}

/** Thrown when `bin/voc-datalake.ts` exits non-zero (a synth-time guard firing). */
export class SynthFailure extends Error {
  constructor(readonly output: string) {
    super(`app synth failed:\n${output}`);
    this.name = 'SynthFailure';
  }
}

/** Synthesize the app with the given extra context. Throws {@link SynthFailure}. */
export function synthApp(context: Record<string, unknown> = {}): SynthResult {
  const outdir = mkdtempSync(join(tmpdir(), 'voc-synth-'));
  try {
    execFileSync(
      process.execPath,
      [require.resolve('ts-node/dist/bin'), '--prefer-ts-exts', join(PROJECT_ROOT, 'bin', 'voc-datalake.ts')],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          CDK_OUTDIR: outdir,
          CDK_DEFAULT_ACCOUNT: SYNTH_ACCOUNT,
          CDK_DEFAULT_REGION: SYNTH_REGION,
          CDK_CONTEXT_JSON: JSON.stringify({ ...baseContext(), ...context }),
        },
      },
    );
  } catch (error) {
    throw new SynthFailure(describeExecError(error));
  }
  return readAssembly(outdir);
}

function describeExecError(error: unknown): string {
  if (!isRecord(error)) return String(error);
  const parts = [error.stdout, error.stderr, error.message]
    .filter((part): part is string => typeof part === 'string' && part.length > 0);
  return parts.join('\n');
}

function readAssembly(outdir: string): SynthResult {
  const manifest: unknown = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8'));
  const artifacts = isRecord(manifest) && isRecord(manifest.artifacts) ? manifest.artifacts : {};

  const stackNames = readdirSync(outdir)
    .filter((entry) => entry.endsWith('.template.json'))
    .map((entry) => entry.slice(0, -'.template.json'.length))
    .sort();

  const annotations: SynthResult['annotations'] = [];
  for (const [stack, artifact] of Object.entries(artifacts)) {
    if (!isRecord(artifact) || !isRecord(artifact.metadata)) continue;
    for (const entries of Object.values(artifact.metadata)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.type !== 'string') continue;
        annotations.push({ stack, type: entry.type, data: JSON.stringify(entry.data ?? null) });
      }
    }
  }

  const raw = (stackName: string): string =>
    readFileSync(join(outdir, `${stackName}.template.json`), 'utf8');

  return {
    outdir,
    stackNames,
    annotations,
    template: (stackName) => {
      const parsed: unknown = JSON.parse(raw(stackName));
      if (!isRecord(parsed)) throw new Error(`${stackName}: template is not an object`);
      return parsed;
    },
    canonicalTemplate: (stackName) => raw(stackName).replace(/\b[0-9a-f]{64}\b/g, '<ASSET_HASH>'),
  };
}
