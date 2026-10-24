/**
 * The CDK suite's temp-dir setup (cdk-tmpdir.setup.ts, a vitest `setupFiles` entry): a bare
 * `new cdk.App()` must synthesize into this file's own directory, which the setup removes when the
 * file ends, never into the system temp dir (where 21,579 ~340 MB assemblies once filled the disk).
 */
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, sep } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';

describe('CDK test temp dirs', () => {
  it('points os.tmpdir at a per-worker directory under voc-cdk-tests', () => {
    const dir = os.tmpdir();
    expect(basename(dirname(dir))).toBe('voc-cdk-tests');
    expect(basename(dir)).toMatch(new RegExp(`^${process.pid}-`));
    expect(existsSync(dir)).toBe(true);
  });

  it('synthesizes a bare App inside that directory', () => {
    const app = new cdk.App();
    new cdk.Stack(app, 'TmpdirProbe');
    const assembly = app.synth();
    // aws-cdk-lib resolves the temp dir first (macOS: /var → /private/var).
    expect(assembly.directory.startsWith(realpathSync(os.tmpdir()) + sep)).toBe(true);
    expect(basename(assembly.directory)).toMatch(/^cdk\.out/);
  });
});
