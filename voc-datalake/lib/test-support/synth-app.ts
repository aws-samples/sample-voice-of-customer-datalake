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
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NameInventory } from './name-inventory';

const PROJECT_ROOT = join(__dirname, '..', '..');

/** Fixed synth environment, so a template hash depends only on the source. */
export const SYNTH_ACCOUNT = '111111111111';
export const SYNTH_REGION = 'us-east-1';

/** Committed fingerprint of the no-prefix synth, relative to the project root. */
export const BASELINE_PATH = 'lib/test-support/baseline.json';

/**
 * Timeout for a suite that calls {@link synthApp} inside a test case.
 *
 * A whole-app synth is ~10s, well past vitest's 5s default. Applied per-suite
 * (`describe(…, SYNTH_TIMEOUT_MS)`) rather than as a global `testTimeout`, so a
 * hung test in one of the other suites still reports in five seconds.
 */
export const SYNTH_TIMEOUT_MS = 120_000;

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
  /**
   * Every diagnostic CDK and cdk-nag reported: warnings, errors and info.
   *
   * Read from the per-stack `<stack>.metadata.json` files, NOT from
   * `manifest.json`'s `artifacts[*].metadata`. Cloud assembly manifest v54
   * moved stack metadata out of the manifest into those side files, leaving the
   * manifest key absent — which silently emptied this list and made every
   * "synthesizes with zero warnings" assertion vacuous. `readsRealAnnotations`
   * below keeps that from recurring undetected.
   */
  annotations: SynthAnnotation[];
  /**
   * Whether the collector found ANY annotation at all, of any type.
   *
   * A synth always emits `aws:cdk:logicalId` and `aws:cdk:creationStack`
   * entries, so `false` here means the collector is reading the wrong place
   * again rather than that the app is clean. Asserted by
   * lib/test-support/synth-app.test.ts, so a zero-warnings check can never pass
   * merely because nothing was parsed.
   */
  readsRealAnnotations: boolean;
}

/** One CDK or cdk-nag annotation, located by the construct path that raised it. */
export interface SynthAnnotation {
  /** Stack artifact id the annotation belongs to. */
  stack: string;
  /** Construct path that raised it, e.g. `/VocApiStack/Role/DefaultPolicy/Resource`. */
  path: string;
  /** `aws:cdk:warning`, `aws:cdk:error`, `aws:cdk:info`, `aws:cdk:logicalId`, … */
  type: string;
  /** The message, or a JSON rendering of a non-string payload. */
  data: string;
}

/**
 * Annotation types a clean synth must not produce.
 *
 * `aws:cdk:info` is deliberately NOT one of them. bin/voc-datalake.ts raises an
 * info annotation ON PURPOSE whenever the app region is not us-east-1 (the
 * issue #205 web-search bootstrap hint), so including it here would assert
 * something stricter than both the repo convention this encodes — "a clean
 * `cdk synth` prints zero warnings" — and than the app can satisfy: the moment
 * the synth region moved off the pinned us-east-1, or anyone reused this
 * constant for a parameterised region, both zero-warnings guards would go red
 * for correct behaviour. Info annotations are still COLLECTED into
 * {@link SynthResult.annotations}; a suite that wants to assert about one can
 * do so explicitly.
 */
export const DIAGNOSTIC_ANNOTATION_TYPES = ['aws:cdk:warning', 'aws:cdk:error'] as const;

/** The diagnostics (warnings and errors) among `annotations`. */
export function diagnostics(result: Pick<SynthResult, 'annotations'>): SynthAnnotation[] {
  const types: readonly string[] = DIAGNOSTIC_ANNOTATION_TYPES;
  return result.annotations.filter((annotation) => types.includes(annotation.type));
}

/** Thrown when `bin/voc-datalake.ts` exits non-zero (a synth-time guard firing). */
export class SynthFailure extends Error {
  constructor(readonly output: string) {
    super(`app synth failed:\n${output}`);
    this.name = 'SynthFailure';
  }
}

/** Assembly directories created by this process, removed when it exits. */
const assemblyDirs: string[] = [];
let exitHookInstalled = false;

/**
 * A temporary cloud assembly directory, removed by {@link cleanupAssemblyDirs}.
 *
 * A whole-app assembly is ~26 MB — it stages the frontend `dist` and every
 * Lambda asset — and a full `vitest run` makes several, so without cleanup one
 * run leaves hundreds of megabytes behind and `vitest --watch` accumulates
 * without bound. Deletion cannot happen per-call: {@link SynthResult} reads
 * templates lazily from `outdir`, so the directory has to outlive the synth —
 * just not the run.
 *
 * Every suite that synthesizes therefore calls `afterAll(cleanupAssemblyDirs)`.
 * The `process.on('exit')` hook below is NOT a substitute for that, and measuring
 * it is the only reason this comment can say so: vitest terminates its worker
 * processes rather than letting them exit, so the hook never runs there (22
 * assemblies survived a run that had it). It earns its place for the non-vitest
 * callers — scripts/generate-baseline.ts is a plain `ts-node` process.
 */
export function createAssemblyDir(prefix: string): string {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', cleanupAssemblyDirs);
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  assemblyDirs.push(dir);
  return dir;
}

/** Remove every directory {@link createAssemblyDir} handed out. Idempotent. */
export function cleanupAssemblyDirs(): void {
  while (assemblyDirs.length > 0) {
    const dir = assemblyDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** Synthesize the app with the given extra context. Throws {@link SynthFailure}. */
export function synthApp(context: Record<string, unknown> = {}): SynthResult {
  const outdir = createAssemblyDir('voc-synth-');
  try {
    // `ts-node/register` is a documented entry point; `ts-node/dist/bin` is
    // ts-node's internal file layout, and a minor release that reorganizes
    // dist/ would break both synth suites with a module-resolution error that
    // says nothing about the real cause. TS_NODE_PREFER_TS_EXTS is the env-var
    // form of the `--prefer-ts-exts` flag the bin shim used to take.
    execFileSync(
      process.execPath,
      ['-r', require.resolve('ts-node/register'), join(PROJECT_ROOT, 'bin', 'voc-datalake.ts')],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          TS_NODE_PREFER_TS_EXTS: 'true',
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

/**
 * Every annotation in the assembly, gathered from the per-stack
 * `<stack>.metadata.json` files.
 *
 * Shape of one of those files (cloud assembly manifest v54):
 *
 *   { "/VocApiStack/Role/DefaultPolicy/Resource": [
 *       { "type": "aws:cdk:error", "data": "AwsSolutions-IAM5[...]: ..." } ] }
 *
 * `manifest.json` (v53 and earlier) is read too, so the collector survives the
 * manifest version moving in either direction — the failure mode being fixed
 * here is precisely that it silently found nothing. But the two sources are
 * ALTERNATIVES, not complements: a per-stack file wins for its own stack, and
 * the manifest is consulted only for stacks that have none. Reading both
 * additively would double every annotation on a manifest version that populated
 * both, which is invisible to the `toEqual([])` assertions and quietly wrong for
 * `nagFindings()` counts.
 */
function readAnnotations(outdir: string): SynthAnnotation[] {
  const annotations: SynthAnnotation[] = [];

  const collect = (stack: string, metadata: unknown): void => {
    if (!isRecord(metadata)) return;
    for (const [path, entries] of Object.entries(metadata)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.type !== 'string') continue;
        const data = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data ?? null);
        annotations.push({ stack, path, type: entry.type, data });
      }
    }
  };

  const suffix = '.metadata.json';
  const sideFiles = readdirSync(outdir).filter((file) => file.endsWith(suffix));
  const covered = new Set(sideFiles.map((file) => file.slice(0, -suffix.length)));
  for (const entry of sideFiles) {
    collect(entry.slice(0, -suffix.length), JSON.parse(readFileSync(join(outdir, entry), 'utf8')));
  }

  const manifest: unknown = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8'));
  const artifacts = isRecord(manifest) && isRecord(manifest.artifacts) ? manifest.artifacts : {};
  for (const [stack, artifact] of Object.entries(artifacts)) {
    if (!covered.has(stack) && isRecord(artifact)) collect(stack, artifact.metadata);
  }

  return annotations;
}

/**
 * Read an already-synthesized cloud assembly.
 *
 * Exported so lib/test-support/synth-app.test.ts can point the collector at an
 * assembly whose findings it KNOWS about, which is the only way to tell "this
 * app is clean" apart from "this collector parses nothing".
 */
export function readAssembly(outdir: string): SynthResult {
  const stackNames = readdirSync(outdir)
    .filter((entry) => entry.endsWith('.template.json'))
    .map((entry) => entry.slice(0, -'.template.json'.length))
    .sort();

  const annotations = readAnnotations(outdir);

  const raw = (stackName: string): string =>
    readFileSync(join(outdir, `${stackName}.template.json`), 'utf8');

  return {
    outdir,
    stackNames,
    annotations,
    readsRealAnnotations: annotations.length > 0,
    template: (stackName) => {
      const parsed: unknown = JSON.parse(raw(stackName));
      if (!isRecord(parsed)) throw new Error(`${stackName}: template is not an object`);
      return parsed;
    },
    canonicalTemplate: (stackName) => raw(stackName).replace(/\b[0-9a-f]{64}\b/g, '<ASSET_HASH>'),
  };
}
